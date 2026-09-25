"""Tests of the contract size gate (python -m pytest contracts/script -q)."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))
import check_sizes as cs  # noqa: E402


def test_limits_warn_and_fail(capsys):
    ok = {"A": {"runtime_size": 20_000, "init_size": 30_000}}
    assert cs.check(ok) == 0
    warn = {"A": {"runtime_size": 23_000, "init_size": 30_000}}          # > 90 %
    assert cs.check(warn) == 0
    assert "WARN" in capsys.readouterr().out
    assert cs.check({"A": {"runtime_size": 24_577, "init_size": 1}}) == 1
    assert cs.check({"A": {"runtime_size": 1, "init_size": 49_153}}) == 1
    assert cs.check({"A": {"runtime_size": 24_576, "init_size": 49_152}}) == 0   # the limits themselves pass


def _artifact(path, src, link_to=None, code="0x6000"):
    refs = {"src/lib/L.sol": {link_to: [{"start": 1, "length": 20}]}} if link_to else {}
    art = {"metadata": {"settings": {"compilationTarget": {src: "X"}}},
           "bytecode": {"object": code, "linkReferences": refs}, "deployedBytecode": {"object": code}}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(art, f)


def test_linked_library_is_measured(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "src" / "lib").mkdir(parents=True)
    (tmp_path / "src" / "R.sol").write_text("")
    (tmp_path / "src" / "lib" / "L.sol").write_text("")
    _artifact(str(tmp_path / "out" / "R.sol" / "R.json"), "src/R.sol", link_to="L")
    _artifact(str(tmp_path / "out" / "L.sol" / "L.json"), "src/lib/L.sol", code="0x" + "00" * 100)
    report = {"R": {"runtime_size": 2, "init_size": 2}}
    cs.add_linked_libraries(report)
    assert report["L"] == {"runtime_size": 100, "init_size": 100}


def test_missing_library_artifact_fails(tmp_path, monkeypatch):
    # review S04-11: a linked library that cannot be measured used to be skipped with exit 0
    monkeypatch.chdir(tmp_path)
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "R.sol").write_text("")
    _artifact(str(tmp_path / "out" / "R.sol" / "R.json"), "src/R.sol", link_to="L")
    with pytest.raises(SystemExit) as e:
        cs.add_linked_libraries({"R": {"runtime_size": 2, "init_size": 2}})
    assert e.value.code == 2


def test_build_failure_is_exit_2(monkeypatch):
    # review S03-8: forge exits 1 without a JSON report when the build fails
    class Proc:
        returncode, stdout, stderr = 1, "", "Error: Compiler run failed"
    monkeypatch.setattr(cs.subprocess, "run", lambda *a, **k: Proc())
    with pytest.raises(SystemExit) as e:
        cs.load(["check_sizes.py"])
    assert e.value.code == 2
