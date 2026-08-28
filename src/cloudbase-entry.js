import cloudbase from "@cloudbase/js-sdk";

globalThis.cloudbase = cloudbase;
console.info("CloudBase SDK ready", cloudbase.version || "3.8.2");
