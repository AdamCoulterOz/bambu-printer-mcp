/** Systematic RS over GF(256), polynomial 0x11d. Wire convention documented at
 * open-bamboo-networking 77de55a research/06.07-tutk.md §6.7.3. */
const exp = new Uint8Array(510), log = new Uint8Array(256);
for (let n = 0, x = 1; n < 255; n++) {
    exp[n] = x;
    log[x] = n;
    x <<= 1;
    if (x & 256)
        x ^= 0x11d;
}
for (let n = 255; n < 510; n++)
    exp[n] = exp[n - 255];
const mul = (a, b) => a && b ? exp[log[a] + log[b]] : 0;
const pow = (a, b) => b === 0 ? 1 : a ? exp[(log[a] * b) % 255] : 0;
function inverse(input) {
    const n = input.length, m = input.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => Number(i === j))]);
    for (let col = 0; col < n; col++) {
        const pivot = m.findIndex((r, i) => i >= col && r[col] !== 0);
        if (pivot < 0)
            throw Error('Singular FEC matrix');
        [m[col], m[pivot]] = [m[pivot], m[col]];
        const factor = exp[255 - log[m[col][col]]];
        for (let j = 0; j < 2 * n; j++)
            m[col][j] = mul(m[col][j], factor);
        for (let i = 0; i < n; i++)
            if (i !== col) {
                const scale = m[i][col];
                if (scale)
                    for (let j = 0; j < 2 * n; j++)
                        m[i][j] ^= mul(scale, m[col][j]);
            }
    }
    return m.map(r => r.slice(n));
}
/** Recover missing data shards. Input is bounded and never modified. */
export function recoverDataShards(k, shards, length) {
    if (!Number.isInteger(k) || k < 1 || k > 32 || !Number.isInteger(length) || length < 1 || length > 1044 || shards.size < k || shards.size > 64)
        throw Error('Invalid FEC group');
    const rows = [...shards.entries()].sort((a, b) => a[0] - b[0]).slice(0, k);
    if (rows.some(([i, b]) => !Number.isInteger(i) || i < 0 || i >= 64 || b.length !== length))
        throw Error('Invalid FEC shard');
    const top = inverse(Array.from({ length: k }, (_, r) => Array.from({ length: k }, (_, c) => pow(r, c))));
    const row = (r) => r < k ? Array.from({ length: k }, (_, i) => Number(i === r)) : Array.from({ length: k }, (_, c) => top.reduce((v, t, j) => v ^ mul(pow(r, j), t[c]), 0));
    const decode = inverse(rows.map(([r]) => row(r)));
    return Array.from({ length: k }, (_, i) => {
        const existing = shards.get(i);
        if (existing)
            return Buffer.from(existing);
        const output = Buffer.alloc(length);
        for (let j = 0; j < k; j++) {
            const factor = decode[i][j];
            if (factor)
                for (let p = 0; p < length; p++)
                    output[p] ^= mul(factor, rows[j][1][p]);
        }
        return output;
    });
}
