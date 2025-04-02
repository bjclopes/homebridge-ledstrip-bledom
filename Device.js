const noble = require("@abandonware/noble");

function hslToRgb(h, s, l) {
  let r, g, b;

  if (s === 0) {
    r = g = b = l; // Achromatic
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
    this.debounceDisconnectInstance = this.createDebounceDisconnect();
    
    noble.on("stateChange", (state) => {
      if (state === "poweredOn") {
        noble.startScanningAsync();
      } else {
        if (this.peripheral) this.peripheral.disconnect();
        this.connected = false;
      }
    });

    noble.on("discover", async (peripheral) => {
      if (peripheral.uuid === this.uuid) {
        log(`Discovered: ${peripheral.uuid} - ${peripheral.advertisement.localName}`);
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
    if (this.connected) return;

    log(`Connecting to ${this.peripheral.uuid}...`);
    try {
      await this.peripheral.connectAsync();
      log("Connected successfully.");
      this.connected = true;
      const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(["fff0"], ["fff3"]);
      this.write = characteristics[0];
    } catch (err) {
      log(`Connection error: ${err.message}, retrying in 5s...`);
      setTimeout(() => this.connectAndGetWriteCharacteristics(), 5000);
    }
  }

  createDebounceDisconnect() {
    let timer;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (this.peripheral && this.connected) {
          log("Disconnecting due to inactivity...");
          await this.peripheral.disconnectAsync();
          this.connected = false;
          log("Disconnected successfully.");
        }
      }, 5000);
    };
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

  async set_power(status) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const buffer = Buffer.from(`7e0404${status ? "01" : "00"}00${status ? "01" : "00"}ff00ef`, "hex");
      log(`Sending power command: ${buffer.toString("hex")}`);
      try {
        await this.writeAsync(buffer);
        this.power = status;
        this.debounceDisconnectInstance();
      } catch (err) {}
    }
  }

  async set_brightness(level) {
    if (level > 100 || level < 0) return;
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const level_hex = level.toString(16).padStart(2, "0");
      const buffer = Buffer.from(`7e0401${level_hex}ffffff00ef`, "hex");
      log(`Sending brightness command: ${buffer.toString("hex")}`);
      try {
        await this.writeAsync(buffer);
        this.brightness = level;
        this.debounceDisconnectInstance();
      } catch (err) {}
    }
  }

  async set_rgb(r, g, b) {
    if (!this.connected) await this.connectAndGetWriteCharacteristics();
    if (this.write) {
      const buffer = Buffer.from(`7e070503${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}10ef`, "hex");
      log(`Sending RGB command: ${buffer.toString("hex")}`);
      try {
        await this.writeAsync(buffer);
        this.debounceDisconnectInstance();
      } catch (err) {}
    }
  }

  async set_hue(hue) {
    this.hue = hue;
    const [r, g, b] = hslToRgb(hue / 360, this.saturation / 100, this.l);
    await this.set_rgb(r, g, b);
  }

  async set_saturation(saturation) {
    this.saturation = saturation;
    const [r, g, b] = hslToRgb(this.hue / 360, saturation / 100, this.l);
    await this.set_rgb(r, g, b);
  }
};
