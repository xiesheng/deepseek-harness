/** Minimal PASS/FAIL harness shared by the learning exams. */

interface Result {
  title: string;
  ok: boolean;
  detail?: string;
}

const results: Result[] = [];

/** Runs one check; a thrown error records FAIL with its message. */
export async function check(
  title: string,
  run: () => unknown | Promise<unknown>,
) {
  try {
    await run();
    results.push({ title, ok: true });
  } catch (error) {
    results.push({
      title,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Compares by JSON encoding, which is enough for the plain data these exams assert on. */
export function expect(actual: unknown, expected: unknown, what: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

/** Polls until `predicate` holds; Cordis resolves injections asynchronously. */
export async function until(
  predicate: () => boolean,
  what: string,
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Prints every result and exits 1 when any check failed. */
export function report(): never {
  for (const { title, ok, detail } of results) {
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${title}${detail ? `\n      ${detail}` : ""}`,
    );
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
