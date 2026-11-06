/**
 * parseFlags(argv, spec).
 *
 * The shared minimal argv splitter, so scripts stop hand-rolling near-identical
 * `for (i=0;i<argv.length;i++) { if (arg==='--x') flags.x=argv[++i]; ... }` loops with their own
 * `--help` handling. It is deliberately NOT a drop-in for every bespoke parser: one that accepts
 * `--flag=value`, gives short flags their own message, or refuses to consume a value that itself
 * looks like a long flag keeps its own loop, because swapping it in would change behaviour.
 *
 * Deliberately minimal: `--key value` and boolean-flag support, plus the `array` type these
 * scripts actually needed (`--from-report a.json b.json`, consuming every following token that
 * is not itself a flag). It does NOT attempt every bespoke behaviour the adopting callers had -
 * each still owns its own defaults object, its own validation (e.g. "must be an integer"), and
 * its own usage text.
 *
 * @typedef {Object} FlagSpec
 * @property {'boolean'|'string'|'array'} [type='string']
 * @property {string[]} [aliases] extra tokens (e.g. `-h`) that mean the same flag
 *
 * @param {string[]} argv
 * @param {{ flags?: Record<string, FlagSpec>, ErrorClass?: typeof Error }} [spec]
 * @returns {{ flags: Record<string, unknown>, positionals: string[] }}
 *
 * - `boolean` flags: presence sets `true`; no value is consumed.
 * - `string` flags (the default type): the NEXT token is consumed as the value, even if it
 *   looks like a flag, matching every original's `argv[++i]` (callers that want "a trailing
 *   flag with no value" to mean something specific, e.g. e2e-shard-plan.mjs's `?? ''`, still
 *   apply that themselves after parseFlags returns).
 * - `array` flags: consume every following token up to (not including) the next token that
 *   starts with `-`, or the end of argv.
 * - Any token starting with `-` that is not a declared flag (or alias): by default throws
 *   `new (spec.ErrorClass ?? Error)('unknown flag "<token>"')`. Pass `unknownFlags:
 *   'positional'` for a caller whose original loop was permissive (fell through to its
 *   `positional.push(a)` catch-all) rather than validating.
 * - Everything else is a positional, in order.
 */
export function parseFlags(argv, spec = {}) {
  const ErrorClass = spec.ErrorClass ?? Error;
  const declared = spec.flags ?? {};
  const unknownFlags = spec.unknownFlags ?? 'throw';

  // Resolve every token that means a declared flag to its canonical name. A spec key
  // `foo` matches the literal argv token `--foo`; each entry in `aliases` (e.g. `-h`)
  // matches literally, since a short flag has no fixed relationship to its long name.
  const byToken = new Map();
  for (const [name, def] of Object.entries(declared)) {
    byToken.set(`--${name}`, name);
    for (const alias of def.aliases ?? []) byToken.set(alias, name);
  }

  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] ?? '');
    const canonical = byToken.get(token);

    if (canonical === undefined) {
      if (token.startsWith('-') && unknownFlags === 'throw') {
        throw new ErrorClass(`unknown flag "${token}"`);
      }
      positionals.push(token);
      continue;
    }

    const type = declared[canonical]?.type ?? 'string';
    if (type === 'boolean') {
      flags[canonical] = true;
    } else if (type === 'array') {
      const values = [];
      while (i + 1 < argv.length && !String(argv[i + 1] ?? '').startsWith('-')) {
        values.push(String(argv[++i]));
      }
      flags[canonical] = values;
    } else {
      i += 1;
      flags[canonical] = argv[i];
    }
  }

  return { flags, positionals };
}
