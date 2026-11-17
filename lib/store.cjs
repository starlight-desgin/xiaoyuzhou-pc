const fs = require('node:fs');
const path = require('node:path');

// Both settings and account tokens stay encrypted with the current Windows user.
class Store {
  constructor(filename, encryption) {
    this.filename = filename;
    this.encryption = encryption;
    this.value = {};
    if (fs.existsSync(filename)) {
      this.value = JSON.parse(encryption.decryptString(fs.readFileSync(filename)));
    }
  }
  get(key, fallback) { return this.value[key] ?? fallback; }
  set(key, value) {
    this.value[key] = value;
    this.save();
  }
  save() {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = this.filename + '.tmp';
    fs.writeFileSync(temporary, this.encryption.encryptString(JSON.stringify(this.value)));
    fs.renameSync(temporary, this.filename);
  }
}
module.exports = { Store };
