BELUCHIS KITCHEN BRIDGE - WINDOWS
==================================
Version 1.0.1 - runs on Node.js 22.23.2

What it does
------------
Runs on a computer inside the restaurant. It watches the online Beluchis
website and prints every new order to a network thermal printer, and the
kitchen screen beeps and rings on new orders.

It starts itself when the computer boots, keeps running in the background
(no window to keep open), and restarts by itself if it ever crashes. It is a
Windows scheduled task called "BeluchisKitchen" - to look after it, open
Task Scheduler and find it under Task Scheduler Library.

The kitchen computer needs internet access, because Node.js is downloaded the
first time you run it. After that it keeps working on the local network alone.

What is in the folder
---------------------
  server.mjs, lib\, public\   The app itself
  start-kitchen.bat           The one you double-click
  fetch-node.bat              Downloads Node.js, and repairs it if damaged
  run-kitchen.cmd             Started by Windows at boot
  install-service.bat         Creates the scheduled task
  .env.example                Settings template
  data\                       Created on first run, your settings + history
  bin\                        Created on first run, holds node.exe
  beluchis-kitchen.log        Created when it first runs

Nothing is installed outside this folder, apart from one scheduled task and
one Windows Firewall rule.

Install - four steps
--------------------
1. Right-click the zip and choose "Extract All...". Extract it to a real
   folder, for example  C:\Beluchis-Kitchen.
   Do not run the files from inside the zip: Windows copies only one file out
   when you double-click something inside a zip, so the rest never arrives.
   start-kitchen.bat will tell you if this has happened.

2. Double-click  start-kitchen.bat
   - The first run creates your .env file and opens it in Notepad.
   - In Notepad set the admin PIN next to  SOURCE_PIN=  for the website
     (ask the owner - the default "1234" will NOT work), then
     save, close Notepad and double-click start-kitchen.bat again.
   - The second run downloads Node.js, about 30 MB. On a slow line this takes
     a minute. This is the only step that needs the internet.

3. A window asks for administrator permission - click Yes.
   The following happens automatically:
     - creates the "BeluchisKitchen" scheduled task, which starts at boot
     - adds a Windows Firewall rule so other kitchen screens on the network
       can open the page
     - starts the bridge
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
  uninstall-service.bat Remove it completely (your settings are kept)
  check-env.bat         Check the machine when something is not working
  fetch-node.bat        Download or repair Node.js on its own

Troubleshooting
---------------
Start with check-env.bat. It checks the app files, the Node.js download, your
.env settings, whether the scheduled task is installed, whether the kitchen
page is answering, and shows the end of the log. Send the whole screen to
whoever set the bridge up.

- The Node.js download failed: the computer had no internet at that moment,
  or something is blocking nodejs.org. Fix the connection and double-click
  start-kitchen.bat again. If antivirus software keeps deleting bin\node.exe,
  add this folder to its exclusions - otherwise it will be downloaded again
  and deleted again on every start.
- "The package is incomplete": the zip was not extracted properly. Extract it
  again with "Extract All...".
- Page won't open: look at beluchis-kitchen.log in this folder.
- Order not printing: Printers tab -> Test on the target printer; check the
  printer is on and waiting on port 9100. The page shows the last error.
- Wrong PIN / site: fix .env, then restart-service.bat.
- To move the bridge to another computer: copy the folder, re-run
  start-kitchen.bat there (first run asks for the PIN again).
- To look after it by hand: Task Scheduler -> Task Scheduler Library ->
  BeluchisKitchen. Right-click to run it now, or to see what happened last
  time it ran.

For support: beluchis.worcester@gmail.com
