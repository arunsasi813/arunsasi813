@echo off
rem ColSift — build a small exe in a clean virtual environment.
rem   build.bat                   one compressed ColSift.exe in dist\
rem   build.bat --mode standalone a folder instead (fastest start)
rem   build.bat --cli             also colsift-cli.exe for scheduled runs
rem   build.bat --lean            drop the openpyxl fallback as well
rem A clean environment matters: Nuitka follows whatever is installed, and a Python
rem that also has pandas / pyarrow / numpy / Qt makes a build hundreds of MB bigger.
setlocal
cd /d "%~dp0"
if not exist .buildenv\Scripts\python.exe (
  echo Creating a clean build environment in .buildenv ...
  py -3 -m venv .buildenv 2>nul || python -m venv .buildenv || goto :fail
)
.buildenv\Scripts\python.exe -m pip install --upgrade pip >nul
.buildenv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-build.txt || goto :fail
.buildenv\Scripts\python.exe build.py %* || goto :fail
echo.
echo Finished — the program is in the dist folder.
exit /b 0
:fail
echo.
echo Build failed — see the messages above.
exit /b 1
