@echo off
setlocal
cd /d "%~dp0"

REM ==================================================================
REM  Sphere launcher
REM
REM  DO NOT run "uv sync" unconditionally here.
REM  "uv sync" is an EXACT sync: it removes every package that is not
REM  declared in pyproject.toml / uv.lock. The offline map toolchain
REM  (pyosmium and friends) is installed by hand via
REM  "uv pip install --no-deps" and is intentionally NOT declared there,
REM  so an unconditional sync DELETES it. (2026-10-27: exactly what
REM  happened - requests/urllib3/zstandard got removed, pyosmium only
REM  survived because its dist-info had no RECORD file.)
REM
REM  The web server itself only needs flask + mapbox-vector-tile, both
REM  present in uv.lock. So: sync ONLY when the venv is missing or
REM  flask cannot be imported. Otherwise launch and never touch it.
REM ==================================================================

set "VENV_PY=%~dp0.venv\Scripts\python.exe"

REM ---------------------------------------------------------------
REM 1) healthy venv -> launch directly (no uv, no sync)
REM ---------------------------------------------------------------
if not exist "%VENV_PY%" goto need_sync
"%VENV_PY%" -c "import flask" >nul 2>&1
if errorlevel 1 goto need_sync

echo [run] venv OK - launching Flask without syncing (tool deps preserved).
"%VENV_PY%" app.py %1
goto end

REM ---------------------------------------------------------------
REM 2) venv missing or flask broken -> create/sync via uv
REM ---------------------------------------------------------------
:need_sync
where uv >nul 2>&1
if errorlevel 1 goto fallback

echo [uv] venv missing or flask not importable - syncing from pyproject.toml...
if not exist ".venv" uv venv
uv sync
if errorlevel 1 goto sync_failed
if not exist "%VENV_PY%" goto sync_failed
echo Starting Flask...
"%VENV_PY%" app.py %1
goto end

:sync_failed
echo ERROR: uv sync failed - see output above.
echo Fix manually, then rerun: uv sync
pause
exit /b 1

REM ---------------------------------------------------------------
REM 3) no uv at all -> system python venv + pip (install flask only)
REM ---------------------------------------------------------------
:fallback
where python >nul 2>&1
if errorlevel 1 goto no_python

echo [fallback] no uv and no usable venv - using python venv + pip install flask...
if not exist ".venv" python -m venv .venv
call ".venv\Scripts\activate.bat"
pip install flask
echo Starting Flask...
python app.py %1
goto end

:no_python
echo ERROR: neither a usable venv, nor uv, nor python found.
echo Install uv:    pip install uv
echo Or Python 3.10+: https://www.python.org/downloads/
pause
exit /b 1

:end
pause
endlocal
