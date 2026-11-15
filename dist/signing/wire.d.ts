/**
 * Low-level MQTT wire encoding. Protocol observations credited to
 * https://github.com/ClusterM/open-bamboo-networking/blob/master/research/10.03-mqtt-field-encryption.md
 * and https://github.com/ClusterM/open-bamboo-networking/blob/master/research/10.04-mqtt-signing.md.
 * This module does not validate certificates, manage sessions or reserve sequence IDs.
 * Callers MUST complete those checks before using it; it does not authorize dispatch.
 */
import { type KeyObject } from "node:crypto";
type Command = "gcode_line" | "project_file" | "pause" | "resume" | "stop" | "clean_print_error" | "print_speed" | "set_airduct" | "ams_get_rfid" | "ams_control" | "skip_objects";
type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export type PrintCommand = {
    command: Command;
    sequence_id: string;
    [key: string]: JsonValue;
};
/** Encode a validated command with already-validated key material. Internal primitive only. */
export declare function encodeSignedPrint(command: PrintCommand, certId: string, appPrivateKey: KeyObject, devicePublicKey: KeyObject): Buffer;
export {};
