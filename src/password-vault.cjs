const { randomUUID } = require("node:crypto");
const { openStore } = require("./store.cjs");

function openPasswordVault(file, safeStorage) {
  const store = openStore(file, { passwords: [] });
  const available = () => safeStorage.isEncryptionAvailable() &&
    !(process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text");
  function entries() {
    const items = store.get().passwords;
    if (!Array.isArray(items)) throw new Error("快捷密码本格式无效");
    return items;
  }
  function find(id) {
    if (typeof id !== "string") throw new Error("无效的快捷密码");
    const item = entries().find(entry => entry.id === id);
    if (!item) throw new Error("这条快捷密码已不存在，请刷新后重试");
    return item;
  }
  function requireEncryption() {
    if (!available()) throw new Error("系统安全存储不可用，无法读取或保存快捷密码");
  }
  return {
    list() {
      return {
        available: available(),
        items: entries().map(({ id, description }) => ({ id, description })),
      };
    },
    save(input) {
      requireEncryption();
      if (!input || typeof input.description !== "string" ||
          !input.description.trim() || input.description.length > 80 || /[\x00-\x1f\x7f]/.test(input.description))
        throw new Error("请输入 1–80 字的密码描述");
      const description = input.description.trim();
      const previous = input.id ? find(input.id) : null;
      if (entries().some(entry => entry.id !== previous?.id && entry.description.toLocaleLowerCase() === description.toLocaleLowerCase()))
        throw new Error("已存在相同的密码描述，请使用可区分的名称");
      const password = input.password;
      if (typeof password !== "string" || (!previous && !password) || password.length > 4096 || /[\x00-\x1f\x7f]/.test(password))
        throw new Error("请输入有效密码，不能包含换行或控制字符");
      if (!previous && entries().length >= 200) throw new Error("最多保存 200 条快捷密码");
      const record = {
        id: previous?.id || randomUUID(), description,
        encrypted: password ? safeStorage.encryptString(password).toString("base64") : previous.encrypted,
      };
      const passwords = previous ? entries().map(entry => entry.id === previous.id ? record : entry) : [record, ...entries()];
      store.write({ passwords });
      return this.list();
    },
    reveal(id) {
      requireEncryption();
      const item = find(id);
      try {
        return safeStorage.decryptString(Buffer.from(item.encrypted, "base64"));
      } catch {
        throw new Error("无法解密这条密码，请使用保存它的系统账户或重新设置密码");
      }
    },
    remove(id) {
      find(id);
      store.write({ passwords: entries().filter(entry => entry.id !== id) });
      return this.list();
    },
  };
}

module.exports = { openPasswordVault };
