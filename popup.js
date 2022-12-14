// Determines which slide should be visible on startup page
let slideIndex = 0;
let object = await chrome.storage.local.get('activeSlide');

if(object.activeSlide != null) {
  slideIndex = object.activeSlide;
}

// Previous slide
document.getElementById("prev").addEventListener("click", function() {
  slideIndex -= 1;
  updateSlide(slideIndex);
});

// Next slide
document.getElementById("next").addEventListener("click", function() {
  slideIndex += 1;
  updateSlide(slideIndex);
});

// Submit activation
let errorSplash = document.getElementById("errorSplash");
let activateButton = document.getElementById("activateButton");

activateButton.addEventListener("click", async function() {
  // Disable button so user can't spam it
  activateButton.disabled = true;
  errorSplash.innerText = "Activating...";
  activateButton.innerText = "Working...";

  try {
    // Split activation code into its two components: identifier and host.
    let code = document.getElementById('code').value.split('-');
    // Decode Base64 to get host
    let host = atob(code[1]);
    let identifier = code[0];
    // Ensure this code is correct by counting the characters
    if(code[0].length != 20 || code[1].length != 38) {
      throw "Illegal number of characters in activation code";
    }
    // Make request. Throws an error if an error occurs
    await activateDevice(host, identifier);
    // Hide setup page and show success page
    changeScreen("success");
  } catch(error) {
    if(error == "Expired") {
      errorSplash.innerText = "Activation code expired. Create a new activation link and try again.";
    }
    else {
      // Timeouts will be caught here
      console.error(error);
      errorSplash.innerText = "Invalid code. Copy the activation code inside the box and paste here.";
    }
  }

  // Re-enable button
  activateButton.disabled = false;
  activateButton.innerText = "Try Again";
});

// Switch to main page after success button is pressed
document.getElementById("successButton").addEventListener("click", function() {
  changeScreen("main");
});

async function activateDevice(host, identifier) {
  let url = 'https://' + host + '/push/v2/activation/' + identifier;

  // Create new pair of RSA keys
  let keyPair = await window.crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
    hash: "SHA-512"
  }, true, ["sign", "verify"]);

  // Convert public key to PEM format to send to Duo
  let pemFormat = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
  pemFormat = window.btoa(String.fromCharCode(...new Uint8Array(pemFormat))).match(/.{1,64}/g).join('\n');
  pemFormat = `-----BEGIN PUBLIC KEY-----\n${pemFormat}\n-----END PUBLIC KEY-----`;

  // Exporting keys returns an array buffer. Convert it to Base64 string for storing
  let publicRaw = arrayBufferToBase64(await window.crypto.subtle.exportKey("spki", keyPair.publicKey));
  let privateRaw = arrayBufferToBase64(await window.crypto.subtle.exportKey("pkcs8", keyPair.privateKey));

  // Initialize new HTTP request
  let request = new XMLHttpRequest();
  let error = false;
  request.open('POST', url, true);
  request.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
  // Put onload() in a Promise. It will be raced with a timeout promise
  let newData = new Promise((resolve, reject) => {
    request.onload = async function () {
      let result = JSON.parse(request.responseText);
      // If successful
      if (result.stat == "OK") {
        // Get device info as JSON
        let deviceInfo = {
          "akey": result.response.akey,
          "pkey": result.response.pkey,
          "host": host,
          // Encode keys to Base64 for JSON serializing
          "publicRaw": publicRaw,
          "privateRaw": privateRaw
        };
        // Store device info in chrome sync
        await chrome.storage.sync.set({"deviceInfo": deviceInfo});
        resolve("Success");
      }
      else {
        // If we receive a result from Duo and the status is FAIL, the activation code is likely expired
        console.error(result);
        reject("Expired");
      }
    };
  });
  // Append URL parameters and begin request
  request.send("?customer_protocol=1&pubkey=" + encodeURIComponent(pemFormat) + "&pkpush=rsa-sha512&jailbroken=false&architecture=arm64&region=US&app_id=com.duosecurity.duomobile&full_disk_encryption=true&passcode_status=true&platform=Android&app_version=3.49.0&app_build_number=323001&version=11&manufacturer=unknown&language=en&model=Chrome%20Extension&security_patch_level=2021-02-01");
  // Create timeout promise
  let timeout = new Promise((resolve, reject) => {
    setTimeout(() => {
      reject("Timed out");
    }, 1500);
  });
  // Wait for response, or timeout at 1.5s
  // We need a timeout because request.send() doesn't return an error when an exception occurs, and onload() is obviously never called
  await Promise.race([newData, timeout]);
}

// On settings gear clicked
let inSettings = false;
let gear = document.getElementById("gear");
gear.addEventListener("click", async function() {
  // If this is the first time we're clicking the gear
  if(!inSettings) {
    // Set gear color to red
    gear.style.fill = "red";
    changeScreen("settings");
  }
  // If we already clicked this
  else {
    // In case the data was tampered with in the settings
    await initialize();
    // Set gear color back to black
    gear.style.fill = "black";
    // Don't count flipping back to main page as an attempt
    failedAttempts = 0;
  }
  inSettings = !inSettings;
});

let splash = document.getElementById("splash");
let checkmark = document.getElementById("checkmark");
let pushButton = document.getElementById("pushButton");
let failedAttempts = 0;

// When the push button is pressed on the main screen
pushButton.addEventListener("click", async function() {
  // Disable button while making Duo request
  pushButton.disabled = true;
  pushButton.innerText = "Working...";
  splash.innerHTML = "Checking for Duo Mobile logins...";
  // Hide checkmark
  checkmark.style.display = "none";

  try {
    // Get device info from storage
    let info = await new Promise(function(resolve) {
      chrome.storage.sync.get('deviceInfo', function(json) {
        resolve(json.deviceInfo);
      });
    });
    let transactions = (await buildRequest(info, "GET", "/push/v2/device/transactions")).response.transactions;
    // If no transactions exist at the moment
    if(transactions.length == 0) {
      failedAttempts++;
      splash.innerHTML = "No logins found. Did you send a push to DuOSU (name is \"Android\")?";
    }
    // Push every transaction
    else {
      // For each transaction
      for(let i = 0; i < transactions.length; i++) {
        let urgID = transactions[i].urgid;
        let response = await buildRequest(info, "POST", "/push/v2/device/transactions/" + urgID, {"answer": "approve"}, {"txId": urgID});

        if(response.stat != "OK") {
          console.error(response);
          throw "Duo returned error status " + response.stat + " while trying to login";
        }
      }
      // If successful, print this message
      splash.innerHTML = "Logged in!";
      failedAttempts = 0;
      // Show checkmark
      checkmark.style.display = "block";
    }
  } catch(error) {
    failedAttempts = 0;
    console.error(error);
    splash.innerHTML = "Failed to login.<br><br>" +
      "Did you delete DuOSU from your devices?\n" +
      "<b>Reset DuOSU by clicking the gear icon and pressing reset.</b>";
  }

  // Re-enable button
  pushButton.disabled = false;
  pushButton.innerHTML = "Try Again";
  // If we couldn't login after many attemps
  if(failedAttempts >= 5) {
    failedAttempts = 0;
    // Remind the user how DuOSU works
    changeScreen("failedAttempts");
  }
});

// When the user presses the 'Got it' button on the failure screen
document.getElementById("failureButton").addEventListener("click", function() {
  changeScreen("main");
});

// Makes a request to the Duo API
async function buildRequest(info, method, path, extraParam = {}, extraHeader = {}) {
  // Manually convert date to UTC
  let now = new Date();
  var utc = new Date(now.getTime() + now.getTimezoneOffset() * 60000);

  // Manually format time because JS doesn't provide regex functions for this
  let date = utc.toLocaleString('en-us', {weekday: 'long'}).substring(0, 3) + ", ";
  date += utc.getDate() + " ";
  date += utc.toLocaleString('en-us', {month: 'long'}).substring(0, 3) + " ";
  date += 1900 + utc.getYear() + " ";
  date += twoDigits(utc.getHours()) + ":";
  date += twoDigits(utc.getMinutes()) + ":";
  date += twoDigits(utc.getSeconds()) + " -0000";

  // Create canolicalized request (signature of auth header)
  // Technically, these parameters should be sorted alphabetically
  // But for our purposes we don't need to for our only extra parameter (answer=approve)
  let canonRequest = date + "\n" + method + "\n" + info.host + "\n" + path + "\n";
  let params = "";

  // We only use 1 extra parameter, but this shouldn't break for extra
  for (const [key, value] of Object.entries(extraParam)) {
    params += "&" + key + "=" + value;
  }

  // Add extra params to canonical request for auth
  if(params.length != 0) {
    // Cutoff first '&'
    params = params.substring(1);
    canonRequest += params;
    // Add '?' for URL when we make fetch request
    params = "?" + params
  }

  // Import keys (convert form Base64 back into ArrayBuffer)
  let publicKey = await window.crypto.subtle.importKey("spki", base64ToArrayBuffer(info.publicRaw), {name: "RSASSA-PKCS1-v1_5", hash: {name: 'SHA-512'},}, true, ["verify"]);
  let privateKey = await window.crypto.subtle.importKey("pkcs8", base64ToArrayBuffer(info.privateRaw), {name: "RSASSA-PKCS1-v1_5", hash: {name: "SHA-512"},}, true, ["sign"]);

  // Sign canonicalized request using RSA private key
  let toEncrypt = new TextEncoder().encode(canonRequest);
  let signed = await window.crypto.subtle.sign({name: "RSASSA-PKCS1-v1_5"}, privateKey, toEncrypt);
  let verified = await window.crypto.subtle.verify({name: "RSASSA-PKCS1-v1_5"}, publicKey, signed, toEncrypt);

  // Ensure keys match
  if(!verified) {
    throw("Failed to verify signature with RSA keys");
  }

  // Required headers for all requests
  let headers = {
    "Authorization": "Basic " + window.btoa(info.pkey + ":" + arrayBufferToBase64(signed)),
    "x-duo-date": date
  }

  // Append additional headers (we only use txId during transaction reply)
  // Unlike extraParams, this won't break if more are supplied (which we don't need)
  for (const [key, value] of Object.entries(extraHeader)) {
    headers[key] = value;
  }

  let result = await fetch("https://" + info.host + path + params, {
    method: method,
    headers: headers
  }).then(response => {
    return response.json();
  });

  return result;
}

// For formatting date header
function twoDigits(input) {
  return input.toString().padStart(2, '0');
}

// Changes the active screen of the page (activation or main)
function changeScreen(id) {
  if(id == "activation") {
    // Initialize the active slide (this is necessary on startup)
    updateSlide(slideIndex);
  }
  else if(id == "settings") {
    // Make sure when we go to settings, we reset the main page
    checkmark.style.display = "none";
    splash.innerHTML = "Click to approve Duo Mobile logins.";
    pushButton.innerText = "Login";
  }

  let screens = document.getElementsByClassName("screen");
  // For each screen div
  for(let i = 0; i < screens.length; i++) {
    let div = screens[i];
    // If this is the screen we want to switch to
    if(div.id == id) {
      // Make it visible
      div.style.display = "block";
    }
    // Make all others invisible
    else {
      div.style.display = "none";
    }
  }
}

// Change the current slide on activation screen
function updateSlide(newIndex) {
  let slides = document.getElementsByClassName("slide");

  for(let i = 0; i < slides.length; i++) {
    slides[i].style.display = "none";
  }

  // Clamp newIndex within bounds
  if(newIndex > slides.length - 1) slideIndex = 0;
  else if(newIndex < 0) slideIndex = slides.length - 1;

  // Store in case user clicks off to browse to Duo tab so they don't have to flip back
  chrome.storage.local.set({"activeSlide": slideIndex});
  slides[slideIndex].style.display = "block";

  // Update slide count
  let count = document.getElementById("counter");
  count.textContent = (slideIndex + 1) + "/" + slides.length;
}

// Convert Base64 string to an ArrayBuffer
function base64ToArrayBuffer(base64) {
  var binary_string = window.atob(base64);
  var len = binary_string.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) {
      bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

// Convert an ArrayBuffer to Base64 encoded string
function arrayBufferToBase64(buffer) {
  let binary = "";
  let bytes = new Uint8Array(buffer);
  let len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Import button
let importText = document.getElementById("importText");
let importSplash = document.getElementById("importSplash");
document.getElementById("importButton").addEventListener("click", async function() {
  try {
    let decoded = window.atob(importText.value);
    let json = JSON.parse(decoded);
    // Tell user we are verifying the integrity of the data
    importSplash.innerText = "Verifying..."
    // We do this by running it through a transactions call
    let transactions = (await buildRequest(json, "GET", "/push/v2/device/transactions")).response.transactions;
    // If an error wasn't thrown, set new data in chrome sync
    chrome.storage.sync.set({"deviceInfo": json});
    importSplash.innerText = "Data imported! DuOSU will now login with this data.";
  } catch(e) {
    console.error(e);
    // Tell the user this is an invalid code
    importSplash.innerText = "Invalid data. Copy directly from export."
  }
});

// Export button
let exportText = document.getElementById("exportText");
document.getElementById("exportButton").addEventListener("click", async function() {
  let info = await new Promise(function(resolve) {
    chrome.storage.sync.get('deviceInfo', function(json) {
      resolve(json.deviceInfo);
    });
  });
  // If the user tried to export when we have no data
  if(info == null) {
    exportText.value = "No data!";
  }
  else {
    // Set text to be data. Scramble with Base64 so the user doesn't try to tamper any of this
    exportText.value = window.btoa(JSON.stringify(info));
  }
});

// Reset button
let resetSplash = document.getElementById("resetSplash");
document.getElementById("resetButton").addEventListener("click", function() {
  // Delete chrome local / sync data
  chrome.storage.sync.clear(function() {
    chrome.storage.local.clear(function() {
      // Reset main page
      slideIndex = 0;
      errorSplash.innerText = "Let's set up DuOSU as one of your Duo devices.";
      activateButton.innerText = "Activate";
      resetSplash.innerText = "Data cleared. Import data or reactivate."
    });
  });
});

// On startup
await initialize();
// Changes the current screen to what it should be depending on if deviceInfo is present
async function initialize() {
  // On open, or when settings are changed, return the screen we should go to
  await chrome.storage.sync.get('deviceInfo', async (info) => {
    // If this is the first time lauching / no data found
    if(info.deviceInfo == null) {
      // Set HTML screen to activate
      changeScreen("activation");
    }
    else {
      // Set to main screen
      changeScreen("main");
      // Auto press the button on open
      pushButton.click();
    }
  });
}
