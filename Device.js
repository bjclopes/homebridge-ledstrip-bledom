const noble = require("@abandonware/noble");

function log(message) {
  console.log(`[homebridge-ledstrip]:`, message);
}

// Monkey patch console.warn to catch critical noble warnings
const originalWarn = console.warn;
console.warn = function (...args) {
  const message = args.join(" ");
  if (message.includes("unknown peripheral")) {
    log("Critical noble failure. Exiting to trigger Homebridge restart...");
    process.exit(1); // Exit to let Homebridge auto-restart the plugin
  }
  originalWarn.apply(console, args);
};

function hslToRgb(h, s, l) {
  let r, g, b;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

module.exports = class Device {
  constructor(uuid) {
    this.uuid = uuid;
    this.connected = false;
    this.power = false;
    this.brightness = 100;
    this.hue = 0;
    this.saturation = 0;
    this.l = 0.5;
    this.peripheral = undefined;
    this.debounceTimer = null;

    noble.on("stateChange", (state) => {
      if (state == "poweredOn") {
        noble.startScanningAsync();
      } else {
        if (this.peripheral) this.peripheral.disconnect();
        this.connected = false;
      }
    });

    noble.on("discover", async (peripheral) => {
      if (peripheral.uuid === this.uuid) {
        if (this.connected || (this.peripheral && this.peripheral.state === 'connecting')) {
          return; // Don't keep trying if we're already connected or connecting
        }

        log(`Discovered target device: ${peripheral.uuid}`);
        this.peripheral = peripheral;
        noble.stopScanning();

        try {
          await this.connectAndGetWriteCharacteristics();
        } catch (err) {
          log(`Connect failed after discovery: ${err.message}`);
          this.peripheral = undefined;
          this.connected = false;
          noble.startScanningAsync(); // Resume scanning
        }
      }
    });
  }

  async connectAndGetWriteCharacteristics() {
    if (!this.peripheral) return;

    if (this.peripheral.state !== 'connected') {
      log(`Connecting to ${this.peripheral.uuid}...`);
      try {
        await this.peripheral.connectAsync();
        log(`Connected`);
        this.connected = true;

        const { characteristics } =
          await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
            ["fff0"],
            ["fff3"]
          );
        this.write = characteristics[0];
      } catch (err) {
        log(`Connection error: ${err.message}`);
        throw err;
      }
    }
  }

  debounceDisconnect() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(async () => {
      if (this.peripheral) {
        log("Disconnecting...");
        await this.peripheral.disconnectAsync();
        log("Disconnected");
        this.connected = false;
      }
    }, 5000);
  }

  async set_power(status) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const buffer = Buffer.from(
        `7e0404${status ? "01" : "00"}00${status ? "01" : "00"}ff00ef`,
        "hex"
      );
      log("Power command sent");
      this.write.write(buffer, true, (err) => {
        if (err) console.log("Error:", err);
        this.power = status;
//        this.debounceDisconnect();
      });
    }
  }

  async set_brightness(level) {
    if (level > 100 || level < 0) return;
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const level_hex = ("0" + level.toString(16)).slice(-2);
      const buffer = Buffer.from(`7e0401${level_hex}ffffff00ef`, "hex");
      log("Brightness command sent");
      this.write.write(buffer, true, (err) => {
        if (err) console.log("Error:", err);
        this.brightness = level;
//        this.debounceDisconnect();
      });
    }
  }

  async set_rgb(r, g, b) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const rhex = ("0" + r.toString(16)).slice(-2);
      const ghex = ("0" + g.toString(16)).slice(-2);
      const bhex = ("0" + b.toString(16)).slice(-2);
      const buffer = Buffer.from(`7e070503${rhex}${ghex}${bhex}10ef`, "hex");
      log("Colour command sent");
      this.write.write(buffer, true, (err) => {
        if (err) console.log("Error:", err);
//        this.debounceDisconnect();
      });
    }
  }

  async set_hue(hue) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      this.hue = hue;
      const rgb = hslToRgb(hue / 360, this.saturation / 100, this.l);
      await this.set_rgb(rgb[0], rgb[1], rgb[2]);
//      this.debounceDisconnect();
    }
  }

  async set_saturation(saturation) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      this.saturation = saturation;
      const rgb = hslToRgb(this.hue / 360, saturation / 100, this.l);
      await this.set_rgb(rgb[0], rgb[1], rgb[2]);
//      this.debounceDisconnect();
    }
  }
};
