const noble = require("@abandonware/noble");

function hslToRgb(h, s, l) {
  var r, g, b;
  if (s == 0) {
    r = g = b = l;
  } else {
    var hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function log(message) {
  console.log(`[@bjclopes/homebridge-ledstrip-bledom]:`, message);
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

    noble.on("stateChange", (state) => {
      if (state === "poweredOn") {
        noble.startScanningAsync();
      } else {
        if (this.peripheral) this.peripheral.disconnect();
        this.connected = false;
      }
    });

    noble.on("discover", async (peripheral) => {
      log(`Discovered: ${peripheral.uuid} - ${peripheral.advertisement.localName}`);
      if (peripheral.uuid === this.uuid) {
        this.peripheral = peripheral;
        noble.stopScanning();
      }
    });
  }

  async connectAndGetWriteCharacteristics() {
    if (!this.peripheral) {
      log("Peripheral not found, starting scan...");
      noble.startScanningAsync();
      return;
    }
    log(`Attempting to connect to ${this.peripheral.uuid}...`);
    try {
      log("Calling connectAsync...");
      await this.peripheral.connectAsync();
      log("Connected successfully.");
      this.connected = true;

      log("Discovering services and characteristics...");
      const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(["fff0"], ["fff3"]);

      if (!characteristics || characteristics.length === 0) {
        log("No write characteristic found.");
        this.connected = false;
        return;
      }

      this.write = characteristics[0];
      log("Write characteristic assigned.");
    } catch (err) {
      log(`Connection error: ${err.message}`);
      this.connected = false;
      setTimeout(() => this.connectAndGetWriteCharacteristics(), 5000);
    }
  }

  debounceDisconnect = (() => {
    let timer;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (this.peripheral && this.connected) {
          log("Disconnecting due to inactivity...");
          try {
            await this.peripheral.disconnectAsync();
            log("Disconnected successfully.");
            this.connected = false;
          } catch (err) {
            log(`Error during disconnect: ${err.message}`);
          }
        }
      }, 5000);
    };
  })();

  async set_power(status) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const buffer = Buffer.from(`7e0404${status ? "01" : "00"}00${status ? "01" : "00"}ff00ef`, "hex");
      log(`Sending power command: ${buffer.toString("hex")}`);
      try {
        await this.writeAsync(buffer);
        this.power = status;
        this.debounceDisconnect();
      } catch (err) {
        log(`Error setting power: ${err.message}`);
        setTimeout(() => this.set_power(status), 2000);
      }
    }
  }

  async set_brightness(level) {
    if (level > 100 || level < 0) return;
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const level_hex = ("0" + level.toString(16)).slice(-2);
      const buffer = Buffer.from(`7e0401${level_hex}ffffff00ef`, "hex");
      log(`Sending brightness command: ${buffer.toString("hex")}`);
      try {
        await this.writeAsync(buffer);
        this.brightness = level;
        this.debounceDisconnect();
      } catch (err) {
        log(`Error setting brightness: ${err.message}`);
        setTimeout(() => this.set_brightness(level), 2000);
      }
    }
  }

  async set_rgb(r, g, b) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const rhex = ("0" + r.toString(16)).slice(-2);
      const ghex = ("0" + g.toString(16)).slice(-2);
      const bhex = ("0" + b.toString(16)).slice(-2);
      const buffer = Buffer.from(`7e070503${rhex}${ghex}${bhex}10ef`, "hex");
      log(`Sending RGB command: ${buffer.toString("hex")}`);
      try {
        await this.writeAsync(buffer);
        this.debounceDisconnect();
      } catch (err) {
        log(`Error setting RGB: ${err.message}`);
        setTimeout(() => this.set_rgb(r, g, b), 2000);
      }
    }
  }

  async set_hue(hue) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      this.hue = hue;
      const rgb = hslToRgb(hue / 360, this.saturation / 100, this.l);
      this.set_rgb(rgb[0], rgb[1], rgb[2]);
      this.debounceDisconnect();
    }
  }

  async set_saturation(saturation) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      this.saturation = saturation;
      const rgb = hslToRgb(this.hue / 360, saturation / 100, this.l);
      this.set_rgb(rgb[0], rgb[1], rgb[2]);
      this.debounceDisconnect();
    }
  }

  async writeAsync(buffer) {
    return new Promise((resolve, reject) => {
      this.write.write(buffer, true, (err) => {
        if (err) {
          log(`Write error: ${err.message}, retrying in 2s...`);
          setTimeout(() => this.writeAsync(buffer), 2000);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
};
