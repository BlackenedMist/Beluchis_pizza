BELUCHIS KITCHEN BRIDGE - WINDOWS
==================================
Version 1.0.0 - built with Node 22.23.2 + NSSM 2.24

What it does
------------
Runs on a computer inside the restaurant. It watches the online Beluchis
website and prints every new order to a network thermal printer, and the
kitchen screen beeps and rings on new orders.

It runs as a Windows SERVICE: starts itself when the computer boots, keeps
running in the background (no window to keep open), and restarts by itself
if it ever crashes.

What's in the folder
--------------------
  bin\node.exe          Node.js runtime (bundled - nothing to install)
  bin\nssm.exe          Service wrapper (bundled - nothing to install)
  server.mjs, lib\, public\   The app itself
  .env.example          Settings template
  data\                 Created on first run (your settings + print history)

Install - four steps
--------------------
1. Move the whole unzipped folder anywhere you like, e.g.
     C:\Beluchis-Kitchen
   Do NOT leave it inside a zip or on the Desktop sub-folder that extracts
   oddly - a normal folder is best. (Keep the folder together; the service
   needs every file where it is.)

2. Double-click  start-kitchen.bat
   - Windows SmartScreen may warn: click "More info" then "Run anyway".
   - The first run creates your .env file and opens it in Notepad.
   - In Notepad set the admin PIN next to  SOURCE_PIN=  for the website
     (ask the owner - the default "1234" will NOT work), then
     save, close Notepad and double-click start-kitchen.bat again.

3. A window asks for administrator permission - click Yes.
   The following happens automatically:
     - installs the "Beluchis Kitchen Bridge" service (auto-start on boot)
     - adds a Windows Firewall rule so other kitchen screens on the network
       can open the page
     - starts the service
     - opens the kitchen page at  http://localhost:3101/

4. Done. Check the page: Orders, Printers and Settings tabs.

Website address
---------------
The .env file already points at the live site (https://beluchis.co.za).
While the site is still being cut over, it only answers on its raw address
http://154.65.100.89 - if the bridge shows "no connection", either use the
Settings tab on the kitchen page, or edit .env like this:
   - put a # in front of  SOURCE_BASE_URL=https://beluchis.co.za
   - remove the # in front of  SOURCE_BASE_URL=http://154.65.100.89
   - save, then double-click restart-service.bat
You can also change the site address any time from the Settings tab on the
kitchen page (no file editing needed).

Printers (thermal)
------------------
Printers tab -> Scan. It finds network thermal printers (port 9100) on your
network automatically. Then:
   Add  -> give it a friendly name
   Test -> prints a test slip
   Set as target -> this printer gets every new order
If the scan misses a printer (e.g. it is on another network or has a name
like "kitchen_printer"), use Add with its name or address directly - a
hostname works if the network resolves it.

Other scripts
-------------
  start-kitchen.bat     Install (first time) or just open the page (after)
  restart-service.bat   Reload the bridge after changing .env
  stop-service.bat      Stop it until the next computer start
  uninstall-service.bat Remove the service completely (settings kept)
  check-env.bat         Show the bundled Node and NSSM versions

Troubleshooting
---------------
- SmartScreen: "More info" -> "Run anyway". Fine to run - nothing is
  installed outside this folder except a small service entry.
- Page won't open: check beluchis-kitchen.log / .err.log in the folder.
- Order not printing: Printers tab -> Test on the target printer; check the
  printer is on, waiting on port 9100. The page shows the last error.
- Wrong PIN / site: fix .env, then restart-service.bat.
- To move the bridge to another computer: copy the folder, re-run
  start-kitchen.bat there (first run asks the PIN again).

For support: beluchis.worcester@gmail.com