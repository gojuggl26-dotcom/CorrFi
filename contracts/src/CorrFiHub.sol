// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ICorrFiHub} from "./interfaces/ICorrFiHub.sol";
import {CorrFiMath} from "./lib/CorrFiMath.sol";
import {CorrFiToken} from "./CorrFiToken.sol";
import {CorrFiVault} from "./CorrFiVault.sol";

/// @title CorrFiHub
/// @notice Shared 5-minute price feed (BarFeed), per-market accumulation (Accumulator) and fair-value state
///         (FairValue), market creation and key registry — docs/s03/01-design.md, M §2.5, §4.1-4.2, §6.2.1, §8.2.2.
contract CorrFiHub is ICorrFiHub, Ownable, EIP712 {
    uint256 internal constant WAD = 1e18;
    uint256 public constant DELTA = 300; // bar length (s)
    int256 public constant WINSOR_C = 4; // c (M §2.5.2)
    uint256 public constant FINALIZE_GRACE = 48 hours; // obsEnd + 48 h exit (M §5.5)
    int256 public constant MAX_ABS_LOG_RETURN = 5e17; // |ln(P_k / P_{k-1})| <= 0.5 (M §6.2.1)
    bytes32 public constant REPORT_TYPEHASH = keccak256("Report(uint8 marketId,uint32 k,uint256 pFair,uint256 h0)");

    // ------------------------------------------------------------------ errors
    error NotReporter();
    error RouterAlreadySet();
    error ZeroAddress();
    error BadTenor();
    error BadForecast();
    error BadParam();
    error TooManyMarkets();
    error UnknownMarket();
    error OffGrid(uint256 t);
    error FromTheFuture(uint256 t);
    error AlreadyPosted(uint256 t);
    error BadPrice(uint256 t);
    error ImplausibleReturn(uint256 t);
    error BadSigner(address recovered); // U-1
    error BarMismatch(uint256 k, uint256 processed, uint256 confirmed); // U-2
    error RecomputeMismatch(uint256 pFair, uint256 h0); // U-3
    error PriceOutOfRange(uint256 pFair); // U-4

    // ------------------------------------------------------------------ events
    event ReporterSet(address reporter);
    event PriceSignerSet(address signer);
    event RouterSet(address router);
    event TreasurySet(address treasury);
    event MarketCreated(
        uint8 indexed marketId,
        address vault,
        address longToken,
        address shortToken,
        uint64 obsStart,
        uint64 obsEnd,
        uint32 n,
        uint32 nMin,
        uint256 pFair0,
        uint256 h00
    );
    event PointPosted(uint256 indexed t, uint256 pA, uint256 pB, bool validA, bool validB);
    event Cranked(uint8 indexed marketId, uint32 fromBar, uint32 toBar, uint32 nValid);
    event ReportAccepted(uint8 indexed marketId, uint32 k, uint256 pFair, uint256 h0, uint256 sig2);

    // ------------------------------------------------------------------ types
    struct PointInput {
        uint64 t;
        uint128 pA;
        uint128 pB;
        bool validA;
        bool validB;
    }

    struct ReportInput {
        uint8 marketId;
        uint32 k;
        uint256 pFair;
        uint256 h0;
        bytes signature;
    }

    /// Parameters of createMarket (fixed for the market's life, M §4.1, §8.1).
    struct MarketInput {
        uint16 tenorDays; // 7, 14 or 28
        uint256 sA; // winsorize scale s_A (WAD), fixed at obsStart
        uint256 sB;
        int256 sAB; // forecast per-bar second moments (WAD), Σ̂future = w Σ̂long + (1-w) Σ̂recent
        uint256 sA2;
        uint256 sB2;
        uint256[10] sigmaTable; // σP(τ) at bin midpoints (WAD)
        uint256 cH; // c_h (WAD)
        uint256 lambda; // σP,bar EMA factor per report (WAD)
        uint256 sigma0; // initial σP,bar (WAD)
    }

    struct Point {
        uint128 pA;
        uint128 pB;
        bool posted;
        bool validA;
        bool validB;
    }

    struct Market {
        // fixed
        address vault;
        uint64 obsStart;
        uint64 obsEnd;
        uint32 n;
        uint32 nMin;
        int256 csA;
        int256 csB;
        int256 sAB;
        uint256 sA2;
        uint256 sB2;
        uint256[10] sigmaTable;
        uint256 cH;
        uint256 lambda;
        // accumulator
        int256 c;
        uint256 va;
        uint256 vb;
        uint32 processed;
        uint32 nValid;
        // fair value
        uint32 confirmed;
        uint256 pFair;
        uint256 h0;
        uint256 sig2;
    }

    // ------------------------------------------------------------------ storage
    uint256 public immutable hFloor; // h_floor (WAD), protocol constant (M §8.1)
    address public immutable usdc;
    address public immutable vaultImplementation;
    address public immutable tokenImplementation;

    address public reporter;
    address public priceSigner;
    address public router;
    address public treasury;

    uint8 public marketCount;
    mapping(uint8 => Market) internal _markets;
    mapping(uint256 => Point) internal _points;

    constructor(address owner_, address usdc_, uint256 hFloor_, address reporter_, address priceSigner_, address treasury_)
        Ownable(owner_)
        EIP712("CorrFi", "1")
    {
        if (usdc_ == address(0) || reporter_ == address(0) || priceSigner_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        hFloor = hFloor_;
        reporter = reporter_;
        priceSigner = priceSigner_;
        treasury = treasury_;
        vaultImplementation = address(new CorrFiVault());
        tokenImplementation = address(new CorrFiToken());
    }

    // ------------------------------------------------------------------ admin (M §3.6)

    function setReporter(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        reporter = r;
        emit ReporterSet(r);
    }

    function setPriceSigner(address s) external onlyOwner {
        if (s == address(0)) revert ZeroAddress();
        priceSigner = s;
        emit PriceSignerSet(s);
    }

    /// The router can be registered once (the vaults trust it for deposit moves).
    function setRouter(address r) external onlyOwner {
        if (router != address(0)) revert RouterAlreadySet();
        if (r == address(0)) revert ZeroAddress();
        router = r;
        emit RouterSet(r);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    // ------------------------------------------------------------------ market creation (M §2.2, §4.1.1, §4.2.2)

    function createMarket(MarketInput calldata p, uint256 pFair0, uint256 h00, bytes calldata signature)
        external
        onlyOwner
        returns (uint8 id)
    {
        if (p.tenorDays != 7 && p.tenorDays != 14 && p.tenorDays != 28) revert BadTenor();
        if (marketCount == type(uint8).max) revert TooManyMarkets();
        if (p.sA == 0 || p.sB == 0 || p.lambda >= WAD || p.cH == 0) revert BadParam();
        int256 csA = WINSOR_C * int256(p.sA);
        int256 csB = WINSOR_C * int256(p.sB);
        // forecast covariance: positive variances, PSD, diagonal <= (c s_i)^2 per bar (M §4.1.1, PROP-04)
        if (
            p.sA2 == 0 || p.sB2 == 0 || uint256(p.sAB * p.sAB) > p.sA2 * p.sB2
                || p.sA2 > uint256(csA * csA) / WAD || p.sB2 > uint256(csB * csB) / WAD
        ) revert BadForecast();

        id = marketCount++;
        Market storage m = _markets[id];
        uint64 obsStart = uint64((block.timestamp + DELTA - 1) / DELTA * DELTA);
        m.obsStart = obsStart;
        m.obsEnd = obsStart + uint64(p.tenorDays) * 1 days;
        m.n = uint32(p.tenorDays) * 288;
        m.nMin = uint32((uint256(m.n) * 99 + 99) / 100); // ceil(0.99 N)
        m.csA = csA;
        m.csB = csB;
        m.sAB = p.sAB;
        m.sA2 = p.sA2;
        m.sB2 = p.sB2;
        m.sigmaTable = p.sigmaTable;
        m.cH = p.cH;
        m.lambda = p.lambda;
        m.sig2 = CorrFiMath.sigmaBar2Init(p.sigma0);

        // initial report (tau = 0): recompute, check value range and signature; confirmed stays 0
        uint256 p0 = CorrFiMath.fairValue(0, 0, 0, 0, m.n, m.sAB, m.sA2, m.sB2);
        uint256 h0_ = CorrFiMath.h0(0, m.sigmaTable, m.cH, hFloor);
        if (p0 != pFair0 || h0_ != h00) revert RecomputeMismatch(p0, h0_);
        if (p0 == 0 || p0 >= WAD) revert PriceOutOfRange(p0);
        _checkSigner(id, 0, p0, h0_, signature);
        m.pFair = p0;
        m.h0 = h0_;

        // per-market vault and tokens (EIP-1167 clones)
        address vault = Clones.clone(vaultImplementation);
        address longToken = Clones.clone(tokenImplementation);
        address shortToken = Clones.clone(tokenImplementation);
        string memory tag = string.concat(_u2s(p.tenorDays), "D #", _u2s(id));
        CorrFiToken(longToken).initialize(vault, string.concat("CorrFi ETH/BTC ", tag, " Long"), "CFL");
        CorrFiToken(shortToken).initialize(vault, string.concat("CorrFi ETH/BTC ", tag, " Short"), "CFS");
        CorrFiVault(vault).initialize(address(this), id, usdc, longToken, shortToken, m.obsEnd);
        m.vault = vault;

        emit MarketCreated(id, vault, longToken, shortToken, m.obsStart, m.obsEnd, m.n, m.nMin, p0, h0_);
    }

    // ------------------------------------------------------------------ reporter entry points (M §4.2.1)

    modifier onlyReporter() {
        if (msg.sender != reporter) revert NotReporter();
        _;
    }

    /// Post price points, then for each report: crank the market and accept the report — one transaction.
    function postAndReport(PointInput[] calldata points, ReportInput[] calldata reports) external onlyReporter {
        for (uint256 i; i < points.length; ++i) _post(points[i]);
        for (uint256 i; i < reports.length; ++i) {
            _crank(reports[i].marketId, type(uint32).max);
            _accept(reports[i]);
        }
    }

    /// Post price points without a report (backfill in several transactions; final-bar fallback of PROP-04).
    function postPoints(PointInput[] calldata points) external onlyReporter {
        for (uint256 i; i < points.length; ++i) _post(points[i]);
    }

    /// Accept a report for bars already accumulated (e.g. after a crank by anyone).
    function submitReport(ReportInput calldata r) external onlyReporter {
        _accept(r);
    }

    /// Anyone can advance the accumulation (M §6.2.1); trading then halts on T-1 until the next report.
    function crank(uint8 marketId, uint32 maxBars) external returns (uint32 processed) {
        return _crank(marketId, maxBars);
    }

    // ------------------------------------------------------------------ internals

    function _post(PointInput calldata pt) internal {
        uint256 t = pt.t;
        if (t % DELTA != 0) revert OffGrid(t);
        if (t > block.timestamp) revert FromTheFuture(t);
        Point storage slot = _points[t];
        if (slot.posted) revert AlreadyPosted(t);
        if (pt.validA ? pt.pA == 0 : pt.pA != 0) revert BadPrice(t);
        if (pt.validB ? pt.pB == 0 : pt.pB != 0) revert BadPrice(t);
        Point storage prev = _points[t - DELTA];
        Point storage next = _points[t + DELTA];
        if (pt.validA) {
            if (prev.posted && prev.validA) _checkReturn(t, prev.pA, pt.pA);
            if (next.posted && next.validA) _checkReturn(t, pt.pA, next.pA);
        }
        if (pt.validB) {
            if (prev.posted && prev.validB) _checkReturn(t, prev.pB, pt.pB);
            if (next.posted && next.validB) _checkReturn(t, pt.pB, next.pB);
        }
        _points[t] = Point(pt.pA, pt.pB, true, pt.validA, pt.validB);
        emit PointPosted(t, pt.pA, pt.pB, pt.validA, pt.validB);
    }

    function _checkReturn(uint256 t, uint256 p0, uint256 p1) internal pure {
        int256 r = CorrFiMath.logRatio(p0, p1);
        if (r > MAX_ABS_LOG_RETURN || r < -MAX_ABS_LOG_RETURN) revert ImplausibleReturn(t);
    }

    function _crank(uint8 id, uint32 maxBars) internal returns (uint32) {
        Market storage m = _market(id);
        uint32 k = m.processed;
        uint32 start = k;
        uint32 stop = maxBars > m.n - k ? m.n : k + maxBars;
        bool pastGrace = block.timestamp >= m.obsEnd + FINALIZE_GRACE;
        int256 c = m.c;
        uint256 va = m.va;
        uint256 vb = m.vb;
        uint32 nValid = m.nValid;
        while (k < stop) {
            uint256 t1 = m.obsStart + uint256(k + 1) * DELTA;
            Point storage a = _points[t1 - DELTA];
            Point storage b = _points[t1];
            if (!(a.posted && b.posted) && !pastGrace) break; // wait for the reporter (backfill) — M §6.2.1
            if (a.posted && b.posted && a.validA && a.validB && b.validA && b.validB) {
                int256 ra = CorrFiMath.winsorize(CorrFiMath.logRatio(a.pA, b.pA), m.csA);
                int256 rb = CorrFiMath.winsorize(CorrFiMath.logRatio(a.pB, b.pB), m.csB);
                (c, va, vb) = CorrFiMath.accumulate(c, va, vb, ra, rb);
                ++nValid;
            }
            ++k;
        }
        if (k != start) {
            m.c = c;
            m.va = va;
            m.vb = vb;
            m.nValid = nValid;
            m.processed = k;
            emit Cranked(id, start, k, nValid);
        }
        return k;
    }

    function _accept(ReportInput calldata r) internal {
        Market storage m = _market(r.marketId);
        if (r.k != m.processed || r.k <= m.confirmed) revert BarMismatch(r.k, m.processed, m.confirmed); // U-2
        _checkSigner(r.marketId, r.k, r.pFair, r.h0, r.signature); // U-1
        uint256 p = CorrFiMath.fairValue(m.c, m.va, m.vb, r.k, m.n, m.sAB, m.sA2, m.sB2);
        uint256 h = CorrFiMath.h0(CorrFiMath.tau(r.k, m.n), m.sigmaTable, m.cH, hFloor);
        if (p != r.pFair || h != r.h0) revert RecomputeMismatch(p, h); // U-3
        if (p == 0 || p >= WAD) revert PriceOutOfRange(p); // U-4
        m.sig2 = CorrFiMath.sigmaBar2Update(m.sig2, int256(p) - int256(m.pFair), r.k - m.confirmed, m.lambda);
        m.confirmed = r.k;
        m.pFair = p;
        m.h0 = h;
        emit ReportAccepted(r.marketId, r.k, p, h, m.sig2);
    }

    function _checkSigner(uint8 id, uint32 k, uint256 pFair, uint256 h0_, bytes calldata signature) internal view {
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REPORT_TYPEHASH, id, k, pFair, h0_)));
        address signer = ECDSA.recover(digest, signature);
        if (signer != priceSigner) revert BadSigner(signer);
    }

    function _market(uint8 id) internal view returns (Market storage m) {
        if (id >= marketCount) revert UnknownMarket();
        m = _markets[id];
    }

    function _u2s(uint256 v) internal pure returns (string memory s) {
        if (v == 0) return "0";
        while (v != 0) {
            s = string.concat(string(abi.encodePacked(bytes1(uint8(48 + v % 10)))), s);
            v /= 10;
        }
    }

    // ------------------------------------------------------------------ views

    function reportDigest(uint8 marketId, uint32 k, uint256 pFair, uint256 h0_) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REPORT_TYPEHASH, marketId, k, pFair, h0_)));
    }

    function point(uint256 t) external view returns (Point memory) {
        return _points[t];
    }

    function marketVault(uint8 id) external view returns (address) {
        return _market(id).vault;
    }

    function marketParams(uint8 id)
        external
        view
        returns (int256 csA, int256 csB, int256 sAB, uint256 sA2, uint256 sB2, uint256[10] memory table, uint256 cH, uint256 lambda)
    {
        Market storage m = _market(id);
        return (m.csA, m.csB, m.sAB, m.sA2, m.sB2, m.sigmaTable, m.cH, m.lambda);
    }

    function settlement(uint8 id) external view returns (Settlement memory s) {
        Market storage m = _market(id);
        s = Settlement(m.processed, m.n, m.nMin, m.nValid, m.c, m.va, m.vb);
    }

    function quoteState(uint8 id) external view returns (Quote memory q) {
        Market storage m = _market(id);
        q = Quote(
            m.pFair, m.h0, m.sig2, m.confirmed, m.processed, m.processed - m.nValid, m.n, m.nMin, m.obsStart, m.obsEnd
        );
    }
}
