import { finiteNumber, hmsCode } from '../safety/printer-state.js';

/** Allowlisted monitoring data; missing telemetry stays null. Never use for print authorization. */
export function compactPrinterStatus(status: any, fresh: boolean) {
  const raw = status?.raw && typeof status.raw === 'object' ? status.raw : {};
  const number = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null => {
    const n = finiteNumber(v); return n !== undefined && n >= min && n <= max ? n : null;
  };
  const safeText = (v: unknown, pattern: RegExp): string | null => typeof v === 'string' && pattern.test(v) ? v : null;
  const integer = (v: unknown, max = 0xffffffff): number | null => {
    const n = number(v, 0, max); return n !== null && Number.isInteger(n) ? n : null;
  };
  const extruders = raw.device?.extruder;
  const packedState = integer(extruders?.state);
  const active = packedState === null || !Array.isArray(extruders?.info) ? undefined : extruders.info.find((v: any) => integer(v?.id, 255) === ((packedState >> 4) & 15));
  const packedTemp = integer(active?.temp);
  const packedChamber = integer(raw.device?.ctc?.info?.temp);
  const model = safeText(status?.model, /^[A-Za-z0-9_-]{1,32}$/);
  const dual = typeof model === 'string' && ['x2d', 'h2d', 'h2dpro', 'h2c'].includes(model.toLowerCase().replace(/[_-]/g, ''));
  const nozzleInfo: Array<{ index: number; position: 'right' | 'left'; actual: number; target: number }> = [];
  if (dual && Array.isArray(extruders?.info)) {
    for (const index of [0, 1]) {
      const matches = extruders.info.filter((v: any) => integer(v?.id, 255) === index);
      const temp = matches.length === 1 ? integer(matches[0]?.temp) : null;
      if (temp !== null) nozzleInfo.push({ index, position: index === 0 ? 'right' : 'left', actual: temp & 0xffff, target: temp >>> 16 });
    }
  }
  const temps = {
    nozzles: nozzleInfo,
    nozzle: { actual: packedTemp !== null ? packedTemp & 0xffff : number(raw.nozzle_temper, -100, 1000), target: packedTemp !== null ? packedTemp >>> 16 : number(raw.nozzle_target_temper, 0, 1000) },
    bed: { actual: number(raw.bed_temper, -100, 1000), target: number(raw.bed_target_temper, 0, 1000) },
    chamber: packedChamber !== null ? packedChamber & 0xffff : number(raw.chamber_temper ?? raw.frame_temper, -100, 1000),
  };
  const slots: Array<Record<string, unknown>> = [];
  const units = Array.isArray(raw.ams?.ams) ? raw.ams.ams : [];
  let slotCount = 0;
  const add = (tray: any, source: 'ams' | 'external', amsId: unknown) => {
    slotCount++;
    if (slots.length >= 128) return;
    slots.push({ source, ams_id: source === 'ams' ? integer(amsId, 255) : null, tray_id: integer(tray?.id, 255),
      material: safeText(tray?.tray_type, /^[A-Za-z0-9 _+.-]{1,40}$/),
      colour: safeText(tray?.tray_color, /^#?[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/),
      remaining_percent: number(tray?.remain, 0, 100) });
  };
  for (const unit of units) if (Array.isArray(unit?.tray)) for (const tray of unit.tray) add(tray, 'ams', unit.id);
  if (Array.isArray(raw.vir_slot) && raw.vir_slot.length) for (const tray of raw.vir_slot) add(tray, 'external', null);
  else if (raw.vt_tray && typeof raw.vt_tray === 'object') add(raw.vt_tray, 'external', null);
  const hms = Array.isArray(raw.hms) ? raw.hms.slice(0, 128).map((v: unknown) => hmsCode(v)?.hex ?? 'MALFORMED') : null;
  const evidence = status?.observation;
  const observedSerial = safeText(status?.observedSerial, /^[A-Za-z0-9_-]{1,64}$/);
  const identitySource = safeText(evidence?.identitySource, /^(?:report|module-serial)$/);
  const requestedAt = number(evidence?.requestedAt), receivedAt = number(evidence?.receivedAt);
  const observation = fresh && evidence?.source === 'mqtt' && observedSerial && identitySource && requestedAt !== null && receivedAt !== null && receivedAt >= requestedAt ? {
    source: 'mqtt', requested_at: requestedAt, received_at: receivedAt, identity_source: identitySource, identity_verified: true,
  } : null;
  const rawState = status?.status ?? raw.gcode_state;
  const state = typeof rawState === 'string' ? safeText(rawState.toUpperCase(), /^[A-Z_]{1,32}$/) : null;
  return { detail: 'compact', connected: status?.connected === true, state,
    model, freshness: observation ? 'fresh_mqtt' : 'not_guaranteed', observation,
    progress: { percent: number(raw.mc_percent, 0, 100), remaining_minutes: number(raw.mc_remaining_time), layer: integer(raw.layer_num), total_layers: integer(raw.total_layer_num) },
    temperatures: temps, slots, slots_truncated: slotCount > slots.length,
    errors: { print_error: integer(raw.print_error), hms, hms_truncated: Array.isArray(raw.hms) && raw.hms.length > 128 },
  };
}
