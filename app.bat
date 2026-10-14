@echo off
setlocal
cd /d "%~dp0"

REM 1) try uv
where uv >nul 2>&1
if not errorlevel 1 goto use_uv

REM 2) fallback: python venv + pip
where python >nul 2>&1
if errorlevel 1 goto no_python

echo [fallback] no uv, using python venv + pip...
if not exist ".venv" (
  python -m venv .venv
  call ".venv\Scripts\activate.bat"
  pip install -r requirements.txt
) else (
  call ".venv\Scripts\activate.bat"
)
echo Starting Flask... http://localhost:5000/
python app.py
goto end

:use_uv
echo [uv] detected. Setting up venv + flask...
if not exist ".venv" (
  uv venv
)
uv pip install -r requirements.txt
echo Starting Flask via uv run... http://localhost:5000/
uv run python app.py
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
