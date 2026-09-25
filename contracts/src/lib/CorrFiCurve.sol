// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title CorrFiCurve
/// @notice Inventory-path integral of the quote curve (M §4.3, §4.5, App. A) — functions F16-F18 of
///         docs/s01/01-fixed-point-spec.md. Inventory q and quantities are in units (1e6 = 1 token); prices in WAD.
///         Numerators are 2*qmax times the integral (unit*WAD) and are divided by D = 2*qmax*WAD exactly once.
library CorrFiCurve {
    uint256 internal constant WAD = 1e18;
    int256 internal constant IWAD = 1e18;

    error BadCurve();
    error BookTooThin();

    struct Curve {
        int256 p; // P_fair
        int256 h; // half-spread h
        int256 hmin; // h_min
        int256 kq; // inventory slope at |q| = qmax (WAD)
        int256 qmax; // units
        int256 d; // 2 * qmax * WAD
        bool alphaConstOne; // P + hmin >= 1  -> alpha == 1
        bool betaConstZero; // P - hmin <= 0  -> beta == 0
        // cut points rounded so that the clipped (constant) piece is the one extended — the linear piece is only
        // used where it lies inside [P + hmin, 1] (alpha) or [0, P - hmin] (beta), M-F1
        int256 q1; // g_alpha = 1        (ceiled: alpha = 1 below)
        int256 qs; // g_alpha = P + hmin (floored: alpha = P + hmin from here)
        int256 qss; // g_beta = P - hmin (ceiled: beta = P - hmin below)
        int256 q0; // g_beta = 0        (floored: beta = 0 from here)
    }

    function make(uint256 p, uint256 h, uint256 hmin, uint256 kq, uint256 qmax) internal pure returns (Curve memory c) {
        if (kq == 0 || qmax == 0 || h < hmin) revert BadCurve();
        c.p = int256(p);
        c.h = int256(h);
        c.hmin = int256(hmin);
        c.kq = int256(kq);
        c.qmax = int256(qmax);
        c.d = 2 * c.qmax * IWAD;
        c.alphaConstOne = p + hmin >= WAD;
        c.betaConstZero = c.p - c.hmin <= 0;
        c.q1 = -_floorDiv(-(c.p + c.h - IWAD) * c.qmax, c.kq);
        c.qs = _floorDiv((c.h - c.hmin) * c.qmax, c.kq);
        c.qss = -_floorDiv((c.h - c.hmin) * c.qmax, c.kq);
        c.q0 = _floorDiv((c.p - c.h) * c.qmax, c.kq);
    }

    // ---------------------------------------------------------------- F16

    /// @dev Branch at q as (A, slope): value = A - slope * kq * q / qmax, slope in {0, 1}.
    function _branch(Curve memory c, bool alpha, int256 q) private pure returns (int256, int256) {
        if (alpha) {
            if (c.alphaConstOne || q < c.q1) return (IWAD, 0);
            if (q < c.qs) return (c.p + c.h, 1);
            return (c.p + c.hmin, 0);
        }
        if (c.betaConstZero || q >= c.q0) return (0, 0);
        if (q < c.qss) return (c.p - c.hmin, 0);
        return (c.p - c.h, 1);
    }

    function _cuts(Curve memory c, bool alpha) private pure returns (uint256 n, int256 lo, int256 hi) {
        if (alpha) return c.alphaConstOne ? (0, int256(0), int256(0)) : (2, c.q1, c.qs);
        return c.betaConstZero ? (0, int256(0), int256(0)) : (2, c.qss, c.q0);
    }

    /// 2*qmax * ∫_a^b f dq, exact (f = alpha if `alpha`, else beta).
    function numer(Curve memory c, bool alpha, int256 a, int256 b) internal pure returns (int256 total) {
        (uint256 n, int256 lo, int256 hi) = _cuts(c, alpha);
        int256 u = a;
        if (n != 0 && a < lo && lo < b) {
            total += _segment(c, alpha, u, lo);
            u = lo;
        }
        if (n != 0 && u < hi && hi < b) {
            total += _segment(c, alpha, u, hi);
            u = hi;
        }
        total += _segment(c, alpha, u, b);
    }

    function _segment(Curve memory c, bool alpha, int256 u, int256 v) private pure returns (int256) {
        (int256 A, int256 sl) = _branch(c, alpha, u);
        return (v - u) * (2 * c.qmax * A - sl * c.kq * (u + v));
    }

    // ---------------------------------------------------------------- F17 (units in, units out)

    function payD1(Curve memory c, int256 q0, uint256 q) internal pure returns (uint256) {
        return _ceilDiv(numer(c, true, q0 - int256(q), q0), c.d);
    }

    function receiveD2(Curve memory c, int256 q0, uint256 q) internal pure returns (uint256) {
        return uint256(numer(c, false, q0, q0 + int256(q)) / c.d);
    }

    function payD3(Curve memory c, int256 q0, uint256 q) internal pure returns (uint256) {
        return q - uint256(numer(c, false, q0, q0 + int256(q)) / c.d);
    }

    function receiveD4(Curve memory c, int256 q0, uint256 q) internal pure returns (uint256) {
        return q - _ceilDiv(numer(c, true, q0 - int256(q), q0), c.d);
    }

    // ---------------------------------------------------------------- F18

    /// Largest Q (units) of Long whose cost does not exceed x.
    function qtyD1ExactIn(Curve memory c, int256 q0, uint256 x) internal pure returns (uint256 q) {
        q = _walk(c, true, q0, -1, false, x, true);
        while (q > 0 && payD1(c, q0, q) > x) --q;
    }

    /// Largest Q (units) of Short whose cost does not exceed x.
    function qtyD3ExactIn(Curve memory c, int256 q0, uint256 x) internal pure returns (uint256 q) {
        q = _walk(c, false, q0, 1, true, x, true);
        while (q > 0 && payD3(c, q0, q) > x) --q;
    }

    /// Smallest Q (units) of Long whose proceeds reach x.
    function qtyD2ExactOut(Curve memory c, int256 q0, uint256 x) internal pure returns (uint256 q) {
        q = _walk(c, false, q0, 1, false, x, false);
        while (receiveD2(c, q0, q) < x) ++q;
        while (q > 0 && receiveD2(c, q0, q - 1) >= x) --q;
    }

    /// Smallest Q (units) of Short whose proceeds reach x.
    function qtyD4ExactOut(Curve memory c, int256 q0, uint256 x) internal pure returns (uint256 q) {
        q = _walk(c, true, q0, -1, true, x, false);
        while (receiveD4(c, q0, q) < x) ++q;
        while (q > 0 && receiveD4(c, q0, q - 1) >= x) --q;
    }

    /// @dev Walk from q0 in `dir` over the pieces of f (or 1 - f), consuming numerator r = x * D.
    function _walk(Curve memory c, bool alpha, int256 q0, int256 dir, bool complement, uint256 x, bool buy)
        private
        pure
        returns (uint256)
    {
        int256 r = int256(x) * c.d;
        int256 pos = q0;
        uint256 done;
        (uint256 n, int256 lo, int256 hi) = _cuts(c, alpha);
        while (true) {
            // next cut strictly beyond pos in the walking direction
            bool has;
            int256 nxt;
            if (n != 0) {
                if (dir < 0) {
                    if (hi < pos) (has, nxt) = (true, hi);
                    else if (lo < pos) (has, nxt) = (true, lo);
                } else {
                    if (lo > pos) (has, nxt) = (true, lo);
                    else if (hi > pos) (has, nxt) = (true, hi);
                }
            }
            (int256 A, int256 sl) = _branch(c, alpha, dir < 0 ? pos - 1 : pos);
            int256 f = c.qmax * A - sl * c.kq * pos; // qmax * f(pos)
            int256 sigma = -dir * sl;
            if (complement) (f, sigma) = (c.qmax * IWAD - f, -sigma);
            if (has) {
                int256 len = nxt > pos ? nxt - pos : pos - nxt;
                int256 full = 2 * f * len + sigma * c.kq * len * len;
                if (buy ? full <= r : full < r) {
                    r -= full;
                    done += uint256(len);
                    pos = nxt;
                    continue;
                }
            }
            return done + _solve(f, sigma, c.kq, r, buy);
        }
        revert(); // unreachable
    }

    function _solve(int256 f, int256 sigma, int256 kq, int256 r, bool buy) private pure returns (uint256) {
        if (sigma > 0) return (Math.sqrt(uint256(f * f + kq * r)) - uint256(f)) / uint256(kq);
        if (sigma < 0) {
            int256 disc = f * f - kq * r;
            if (disc < 0) revert BookTooThin();
            return _ceilDiv(f - int256(Math.sqrt(uint256(disc))), kq);
        }
        if (f <= 0) revert BookTooThin();
        return buy ? uint256(r / (2 * f)) : _ceilDiv(r, 2 * f);
    }

    // ---------------------------------------------------------------- helpers

    function _floorDiv(int256 a, int256 b) private pure returns (int256 q) {
        q = a / b;
        if (a % b != 0 && ((a < 0) != (b < 0))) --q;
    }

    function _ceilDiv(int256 a, int256 b) private pure returns (uint256) {
        // callers only pass a >= 0, b > 0
        return uint256((a + b - 1) / b);
    }
}
