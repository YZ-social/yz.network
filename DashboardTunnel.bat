@echo off
echo Opening SSH tunnel to YZ Network Dashboard...
echo Dashboard will be available at: http://localhost:3001
echo Press Ctrl+C to close the tunnel
echo.
ssh -L 3001:localhost:3001 oracle-yz
