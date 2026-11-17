/** Handy's task listing is an offset/limit account endpoint with a deviceId filter:
 * decompiled defpackage/sfn.java, method c. Never trust that filter without
 * checking each returned row. Totals refer to the filtered upstream query. */
type Json = Record<string, unknown>;
export interface HistoryPageOptions { offset?: number; limit?: number }
export function historyPageRequest(serial: string, options: HistoryPageOptions = {}): {path: string; offset: number; limit: number} {
  const offset = options.offset ?? 0, limit = options.limit ?? 50;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(serial) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid cloud history page request.');
  const query = new URLSearchParams({offset: String(offset), limit: String(limit), deviceId: serial});
  return {path: `/v1/user-service/my/tasks?${query}`, offset, limit};
}
export function projectHistoryPage(result: Json, serial: string, offset: number, limit: number): Json {
  if (!Array.isArray(result.hits) || result.hits.length > limit || result.hits.some(row => !row || typeof row !== 'object' || Array.isArray(row) || row.deviceId !== serial || !(typeof row.id==='number' && Number.isSafeInteger(row.id) && row.id>0 || typeof row.id==='string' && /^[1-9]\d{0,19}$/.test(row.id)))) throw new Error('Invalid Bambu history page.');
  const total = result.total;
  if (!Number.isSafeInteger(total) || (total as number) < 0 || (result.hits.length>0 && offset + result.hits.length > (total as number))) throw new Error('Invalid Bambu history page.');
  const allowed = ['id','title','status','startTime','endTime','weight','length','costTime','designId','modelId','profileId','plateIndex','mode','bedType'];
  const tasks = result.hits.map((row: Json) => Object.fromEntries(Object.entries(row).filter(([key,value]) => allowed.includes(key) && (typeof value === 'string' && value.length <= 512 && !value.includes('://') || typeof value === 'number' && Number.isFinite(value)))));
  const consumed = offset + tasks.length;
  if (tasks.length === 0 && consumed < (total as number)) throw new Error('Invalid Bambu history page.');
  return {tasks, offset, limit, printer_reported_total: total, next_offset: consumed < (total as number) ? consumed : null};
}
