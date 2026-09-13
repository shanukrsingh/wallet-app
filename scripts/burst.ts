/**
 * Run: npm run burst -- http://localhost:3000
 *
 * Scenarios covered:
 * - **Concurrent get-or-create:** fire N simultaneous `POST /wallets` for a brand-new user; expect exactly one wallet.
 * - **Idempotent retry storm:** fire the same transfer (same key) K times concurrently; expect exactly one debit/credit and identical responses.
 * - **Conservation under contention:** many concurrent transfers among a small set of wallets (including A→B and B→A at once); at the end, total balance is unchanged and no balance is negative.
 */
const base = process.argv[2] ?? "http://localhost:3000";
const json = (path: string, method: string, token: string, body?: object) =>
  fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function main() {
  const suffix = Date.now();

  const user = `burst-${suffix}`;
  const wallets = await Promise.all(
    Array.from({ length: 150 }, () => json("/wallets", "POST", user, {})),
  );
  const ids = [...new Set(wallets.map((r: any) => r.body.id))];
  console.log("Concurrent get-or-create (150 simultaneous POST /wallets): unique wallet ids =", ids.length);
  if (ids.length !== 1) { console.error("SCENARIO 1 FAIL"); process.exit(1); }

  const a = (await json("/wallets", "POST", `a-${suffix}`, {})).body.id;
  const b = (await json("/wallets", "POST", `b-${suffix}`, {})).body.id;
  const stormBody = { from: a, to: b, amount_paise: 1000, idempotency_key: `retry-${suffix}` };
  const storm = await Promise.all(
    Array.from({ length: 150 }, () => json("/transfers", "POST", `a-${suffix}`, stormBody)),
  );
  const stormIds = new Set(storm.map((r: any) => r.body.id));
  const stormBodies = new Set(storm.map((r: any) => JSON.stringify(r.body)));
  const stormStatuses = [...new Set(storm.map((r) => r.status))];
  console.log("Idempotent retry storm (150 concurrent same key): statuses =", stormStatuses, "transfer ids =", stormIds.size, "identical bodies =", stormBodies.size);
  if (stormIds.size !== 1 || stormBodies.size !== 1 || stormStatuses.length !== 1) { console.error("SCENARIO 2 FAIL"); process.exit(1); }

  const owners = ["c", "d", "e", "f"].map((x) => `cont-${x}-${suffix}`);
  const wids = await Promise.all(
    owners.map((o) => json("/wallets", "POST", o, {}).then((r) => r.body.id)),
  );
  const before = await Promise.all(
    wids.map((id, i) => json(`/wallets/${id}`, "GET", owners[i])),
  );
  const totalBefore = before.reduce((n, r: any) => n + r.body.balance_paise, 0);
  const moves = Array.from({ length: 150 }, (_, i) => {
    const from = i % 4;
    let to = (i * 7) % 4;
    if (to === from) to = (to + 1) % 4;
    if (i === 1) to = 0;
    const overdraw = i % 20 === 0;
    return { from: wids[from], to: wids[to], amount_paise: overdraw ? 150000 : 1 + ((i * 13) % 120000), idempotency_key: `contention-${suffix}-${i}` };
  });
  const results = await Promise.all(
    moves.map((m) => json("/transfers", "POST", owners[wids.indexOf(m.from)], m)),
  );
  const statuses = [...new Set(results.map((r) => r.status))];
  const after = await Promise.all(
    wids.map((id, i) => json(`/wallets/${id}`, "GET", owners[i])),
  );
  const balances = after.map((r: any) => r.body.balance_paise);
  const totalAfter = balances.reduce((n, x) => n + x, 0);
  console.log("Conservation under contention (150 transfers): statuses =", statuses, "conserved =", totalBefore === totalAfter, "balances =", balances);
  if (totalBefore !== totalAfter || balances.some((x: number) => x < 0)) { console.error("SCENARIO 3 FAIL"); process.exit(1); }

  console.log("\nALL SCENARIOS PASSED");
}

main().catch((error) => { console.error(error); process.exit(1); });