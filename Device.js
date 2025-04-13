const noble = require("@abandonware/noble");

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
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
  console.log(`[homebridge-ledstrip]:`, message);
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
    this.write = undefined;
    this.connecting = false;
    this.commandQueue = Promise.resolve();

    noble.on("stateChange", (state) => {
      if (state === "poweredOn") {
        noble.startScanningAsync();
      } else {
        if (this.peripheral) this.peripheral.disconnect();
        this._resetState();
      }
    });

    noble.on("discover", async (peripheral) => {
      log(`Discovered: ${peripheral.uuid} - ${peripheral.advertisement.localName}`);
      if (peripheral.uuid === this.uuid) {
        this.peripheral = peripheral;
        noble.stopScanning();
        await this.enqueue(() => this.connect());
      }
    });
  }

  _resetState() {
    this.connected = false;
    this.connecting = false;
    this.peripheral = undefined;
    this.write = undefined;
  }

  enqueue(task) {
    this.commandQueue = this.commandQueue.then(task).catch(err => {
      log(`Command queue error: ${err.message}`);
    });
    return this.commandQueue;
  }

  async connect(retries = 5) {
    if (this.connecting || this.connected) return;

    if (!this.peripheral) {
      log("Peripheral missing, scanning...");
      const found = await new Promise((resolve) => {
        const onDiscover = (peripheral) => {
          if (peripheral.uuid === this.uuid) {
            log(`Re-discovered peripheral: ${peripheral.uuid}`);
            noble.removeListener("discover", onDiscover);
            noble.stopScanning();
            this.peripheral = peripheral;
            resolve(true);
          }
        };
        noble.on("discover", onDiscover);
        noble.startScanning();

        setTimeout(() => {
          noble.removeListener("discover", onDiscover);
          noble.stopScanning();
          resolve(false);
        }, 5000); // Scan timeout
      });

      if (!found) {
        log("Peripheral not found during scan.");
        return;
      }
    }

    this.connecting = true;
    try {
      log(`Attempting to connect to ${this.peripheral.uuid}...`);
      await this.peripheral.connectAsync();
      await new Promise((res) => setTimeout(res, 500));
      log("Connected successfully.");

      const { characteristics } = await this.peripheral.discoverSomeServicesAndCharacteristicsAsync(
        ["fff0"],
        ["fff3"]
      );

      if (!characteristics || characteristics.length === 0) {
        throw new Error("Write characteristic not found.");
      }

      this.write = characteristics[0];
      this.connected = true;
      log("Write characteristic assigned.");

      this.peripheral.once("disconnect", () => {
        log("Peripheral disconnected.");
        this._resetState();
      });
    } catch (err) {
      log(`Connection error: ${err.message}`);
      this._resetState();
      if (retries > 0) {
        log(`Retrying connect (${retries} retries left)...`);
        await new Promise((res) => setTimeout(res, 1000));
        return this.connect(retries - 1);
      } else {
        log("Max connection retries reached.");
      }
    } finally {
      this.connecting = false;
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
            this._resetState();
          } catch (err) {
            log(`Error during disconnect: ${err.message}`);
          }
        }
      }, 5000);
    };
  })();

  async waitForWriteReady(retries = 10, delay = 300) {
    for (let i = 0; i < retries; i++) {
      if (this.write) return;
      await new Promise(res => setTimeout(res, delay));
    }
    throw new Error("Write characteristic is not ready after multiple retries.");
  }

  async writeCommand(buffer) {
    return this.enqueue(async () => {
      await this.connect();
      await this.waitForWriteReady();
      log(`Sending command: ${buffer.toString("hex")}`);
      await this.writeAsync(buffer);
      this.debounceDisconnect();
    });
  }

  async set_power(status) {
    const buffer = Buffer.from(`7e0404${status ? "01" : "00"}00${status ? "01" : "00"}ff00ef`, "hex");
    this.power = status;
    return this.writeCommand(buffer);
  }

  async set_brightness(level) {
    if (level > 100 || level < 0) return;
    const level_hex = ("0" + level.toString(16)).slice(-2);
    const buffer = Buffer.from(`7e0401${level_hex}ffffff00ef`, "hex");
    this.brightness = level;
    return this.writeCommand(buffer);
  }

  async set_rgb(r, g, b) {
    const rhex = ("0" + r.toString(16)).slice(-2);
    const ghex = ("0" + g.toString(16)).slice(-2);
    const bhex = ("0" + b.toString(16)).slice(-2);
    const buffer = Buffer.from(`7e070503${rhex}${ghex}${bhex}10ef`, "hex");
    return this.writeCommand(buffer);
  }

  async set_hue(hue) {
    this.hue = hue;
    const rgb = hslToRgb(hue / 360, this.saturation / 100, this.l);
    return this.set_rgb(rgb[0], rgb[1], rgb[2]);
  }

  async set_saturation(saturation) {
    this.saturation = saturation;
    const rgb = hslToRgb(this.hue / 360, saturation / 100, this.l);
    return this.set_rgb(rgb[0], rgb[1], rgb[2]);
  }

  async writeAsync(buffer) {
    return new Promise((resolve, reject) => {
      if (!this.write) {
        return reject(new Error("Write characteristic is undefined."));
      }
      this.write.write(buffer, true, (err) => {
        if (err) {
          log(`Write error: ${err.message}`);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
};
