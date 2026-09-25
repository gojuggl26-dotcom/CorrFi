"""Keccak-256 against values from Foundry's cast (cast keccak)."""
from corrfi_verifier.keccak import keccak_hex


def test_known_values():
    assert keccak_hex(b"") == "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    assert keccak_hex(b"abc") == "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    # 512 bytes: several 136-byte blocks
    assert keccak_hex(bytes(range(256)) * 2) == "0xf55ba327291604f0e5be6651752398b7be2331aad65f5763ce067df95cc13be1"
    # the rate boundary: 135, 136 and 137 bytes pad differently
    assert len({keccak_hex(b"x" * n) for n in (135, 136, 137)}) == 3
