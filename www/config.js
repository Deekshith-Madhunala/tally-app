/* Where the Tally server lives.
   "" (empty) = the same address that served this page. This is right when you deploy the whole folder
   with the included server (Render, Railway, your own server...).
   Phone apps built with Capacitor, or a web page hosted somewhere else, need the full address instead,
   for example: window.TALLY_API = "https://tally-yourname.onrender.com";
   If no server answers, the app simply works offline on the device. */
window.TALLY_API = "";
