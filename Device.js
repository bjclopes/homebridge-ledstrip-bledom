const noble = require("@abandonware/noble");

function hslToRgb(h, s, l) {
  let r, g, b;

  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const hue2rgb = (p, q, t) => {
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

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`[@bjclopes/homebridge-ledstrip-bledom] [${timestamp}]:`, message);
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
    this.timer = null;

    this.debounceDisconnect = this.debounceDisconnect.bind(this);

    noble.on("stateChange", (state) => {
      if (state === "poweredOn") {
        noble.startScanningAsync().catch((err) =>
          log(`Error starting scan: ${err.message}`)
        );
      } else {
        this.cleanupConnection();
      }
    });

    noble.on("discover", (peripheral) => {
      log(`Discovered ${peripheral.uuid} (${peripheral.advertisement.localName})`);
      if (peripheral.uuid === this.uuid) {
        this.peripheral = peripheral;
        noble.stopScanningAsync().catch((err) =>
          log(`Error stopping scan: ${err.message}`)
        );
      }
    });
  }

  async connectAndGetWriteCharacteristics() {
    if (!this.peripheral) {
      log("Peripheral not found, restarting scan...");
      noble.startScanningAsync().catch((err) =>
        log(`Error starting scan: ${err.message}`)
      );
      return;
    }

    try {
      log(`Connecting to ${this.peripheral.uuid}...`);
      await this.peripheral.connectAsync();
      log(`Connected to ${this.peripheral.uuid}`);
      this.connected = true;

      const { characteristics } =
        await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
          ["fff0"],
          ["fff3"]
        );
      this.write = characteristics[0];
    } catch (err) {
      log(`Error during connection: ${err.message}`);
      this.cleanupConnection();
    }
  }

  debounceDisconnect() {
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      if (this.peripheral && this.connected) {
        try {
          log("Disconnecting...");
          await this.peripheral.disconnectAsync();
          log("Disconnected");
        } catch (err) {
          log(`Error during disconnection: ${err.message}`);
        } finally {
          this.cleanupConnection();
        }
      }
    }, 5000);
  }

  cleanupConnection() {
    if (this.peripheral) {
      try {
        this.peripheral.disconnect();
      } catch (err) {
        log(`Error cleaning up connection: ${err.message}`);
      }
    }
    this.connected = false;
    this.peripheral = undefined;
  }

  async sendCommand(buffer) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      return new Promise((resolve, reject) => {
        this.write.write(buffer, true, (err) => {
          if (err) {
            log(`Error writing to device: ${err.message}`);
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }
  }

  async set_power(status) {
    const buffer = Buffer.from(
      `7e0404${status ? "01" : "00"}00${status ? "01" : "00"}ff00ef`,
      "hex"
    );
    log(`Setting power to ${status ? "ON" : "OFF"}`);
    try {
      await this.sendCommand(buffer);
      this.power = status;
      this.debounceDisconnect();
    } catch (err) {
      log(`Failed to set power: ${err.message}`);
    }
  }

  async set_brightness(level) {
    if (level > 100 || level < 0) {
      log("Brightness level must be between 0 and 100");
      return;
    }
    const levelHex = level.toString(16).padStart(2, "0");
    const buffer = Buffer.from(`7e0401${levelHex}ffffff00ef`, "hex");
    log(`Setting brightness to ${level}`);
    try {
      await this.sendCommand(buffer);
      this.brightness = level;
      this.debounceDisconnect();
    } catch (err) {
      log(`Failed to set brightness: ${err.message}`);
    }
  }

  async set_rgb(r, g, b) {
    const rHex = r.toString(16).padStart(2, "0");
    const gHex = g.toString(16).padStart(2, "0");
    const bHex = b.toString(16).padStart(2, "0");
    const buffer = Buffer.from(`7e070503${rHex}${gHex}${bHex}10ef`, "hex");
    log(`Setting RGB to (${r}, ${g}, ${b})`);
    try {
      await this.sendCommand(buffer);
      this.debounceDisconnect();
    } catch (err) {
      log(`Failed to set RGB: ${err.message}`);
    }
  }

  async set_hue(hue) {
    this.hue = hue;
    const rgb = hslToRgb(hue / 360, this.saturation / 100, this.l);
    await this.set_rgb(rgb[0], rgb[1], rgb[2]);
  }

  async set_saturation(saturation) {
    this.saturation = saturation;
    const rgb = hslToRgb(this.hue / 360, saturation / 100, this.l);
    await this.set_rgb(rgb[0], rgb[1], rgb[2]);
  }
};
