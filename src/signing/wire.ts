/**
 * Low-level MQTT wire encoding. Protocol observations credited to
 * https://github.com/ClusterM/open-bamboo-networking/blob/master/research/10.03-mqtt-field-encryption.md
 * and https://github.com/ClusterM/open-bamboo-networking/blob/master/research/10.04-mqtt-signing.md.
 * This module does not validate certificates, manage sessions or reserve sequence IDs.
 * Callers MUST complete those checks before using it; it does not authorize dispatch.
 */
import { constants, publicEncrypt, sign, type KeyObject } from "node:crypto";

type Command = "gcode_line" | "project_file" | "pause" | "resume" | "stop" | "clean_print_error" | "print_speed" | "set_airduct" | "ams_get_rfid" | "ams_control" | "skip_objects";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type PrintCommand = { command: Command; sequence_id: string; [key: string]: JsonValue };

const common = ["command", "sequence_id"];
const fields: Record<Command, readonly string[]> = {
  gcode_line: [...common, "param"],
  project_file: [...common, "param", "url", "file", "md5", "bed_type", "timelapse", "bed_leveling", "auto_bed_leveling", "flow_cali", "vibration_cali", "layer_inspect", "use_ams", "cfg", "extrude_cali_flag", "extrude_cali_manual_mode", "nozzle_offset_cali", "subtask_name", "profile_id", "project_id", "subtask_id", "task_id", "ams_mapping", "ams_mapping2", "nozzle_mapping"],
  pause: [...common, "param"], resume: [...common, "param"], stop: [...common, "param"],
  clean_print_error: [...common], print_speed: [...common, "param"],
  set_airduct: [...common, "modeId", "submode"], ams_get_rfid: [...common, "ams_id", "slot_id"],
  ams_control: [...common, "param", "ams_id"], skip_objects: [...common, "obj_list"],
};

/** Encode a validated command with already-validated key material. Internal primitive only. */
export function encodeSignedPrint(command: PrintCommand, certId: string, appPrivateKey: KeyObject, devicePublicKey: KeyObject): Buffer {
  if (!Object.prototype.hasOwnProperty.call(fields, command.command) || !/^\d+$/.test(command.sequence_id)) throw new Error("Invalid signed command");
  if (!certId || appPrivateKey.type !== "private" || appPrivateKey.asymmetricKeyType !== "rsa" || devicePublicKey.type !== "public" || devicePublicKey.asymmetricKeyType !== "rsa") throw new Error("Invalid signing material");
  const allowed = fields[command.command];
  if (Object.keys(command).some(key => !allowed.includes(key))) throw new Error("Unsupported signed command field");
  if (command.command === "ams_control" && (!Number.isInteger(command.ams_id) || Number(command.ams_id) < 0 || (Number(command.ams_id) > 3 && command.ams_id !== 128) || !["start_drying", "stop_drying"].includes(String(command.param)))) throw new Error("Invalid AMS drying command");
  if (command.command === "project_file" && command.nozzle_mapping !== undefined && (!Array.isArray(command.nozzle_mapping) || command.nozzle_mapping.length < 1 || command.nozzle_mapping.length > 64 || command.nozzle_mapping.some(value => !Number.isInteger(value) || Number(value) < 0 || Number(value) > 1))) throw new Error("Invalid nozzle mapping");
  const payload = { ...command };
  const sensitive = command.command === "gcode_line" ? "param" : command.command === "project_file" ? "url" : undefined;
  if (sensitive) {
    const value = payload[sensitive];
    if (typeof value !== "string" || !value) throw new Error("Missing encrypted field");
    const modulusBits = devicePublicKey.asymmetricKeyDetails?.modulusLength;
    if (!modulusBits || modulusBits < 2048 || modulusBits % 8 !== 0) throw new Error("Unsupported device key");
    const input = Buffer.from(value, "utf8");
    const chunkSize = modulusBits / 8 - 11;
    const blocks: Buffer[] = [];
    for (let i = 0; i < input.length; i += chunkSize) blocks.push(publicEncrypt({ key: devicePublicKey, padding: constants.RSA_PKCS1_PADDING }, input.subarray(i, i + chunkSize)));
    delete payload[sensitive];
    payload[`${sensitive}_enc`] = Buffer.concat(blocks).toString("base64");
  }
  const serialized = JSON.stringify({ print: payload });
  const bytes = Buffer.from(serialized, "utf8");
  const signature = sign("sha256", bytes, { key: appPrivateKey, padding: constants.RSA_PKCS1_PADDING });
  const header = { cert_id: certId, payload_len: bytes.length, sign_alg: "RSA_SHA256", sign_ver: "v1.0", sign_string: signature.toString("base64") };
  return Buffer.from(`{"header":${JSON.stringify(header)},${serialized.slice(1)}`, "utf8");
}
