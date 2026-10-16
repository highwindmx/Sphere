@echo off
setlocal
cd /d "%~dp0"

REM 1) try uv (preferred; reads pyproject.toml)
where uv >nul 2>&1
if not errorlevel 1 goto use_uv

REM 2) fallback: python venv + pip (install flask only)
where python >nul 2>&1
if errorlevel 1 goto no_python

echo [fallback] no uv, using python venv + pip install flask...
if not exist ".venv" python -m venv .venv
call ".venv\Scripts\activate.bat"
pip install flask
echo Starting Flask...
python app.py %1
goto end

:use_uv
echo [uv] detected. Syncing venv from pyproject.toml...
if not exist ".venv" uv venv
uv sync
echo Starting Flask via uv run...
uv run python app.py %1
goto end

:no_python
echo ERROR: neither uv nor python found.
echo Install uv:  pip install uv
echo Or Python 3.10+: https://www.python.org/downloads/
pause
exit /b 1

:end
pause
endlocal
