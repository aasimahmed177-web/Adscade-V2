import { spawnSync } from 'node:child_process';

// Independent test processes isolate mocked fetch and environment settings. These
// suites use only simulated services, never a configured production deployment.
const suites = ['appsscript-test', 'calendly-targets-test', 'calendlyClient-test', 'workflow-test'];
let failures = 0;
for (const suite of suites) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', `tools/${suite}.mjs`], { encoding: 'utf8' });
  console.log(`${run.status === 0 ? 'PASS' : 'FAIL'} ${suite}`);
  if (run.status !== 0) {
    failures++;
    console.error(run.stdout, run.stderr, run.error?.message ?? '');
  }
}
console.log(`${suites.length - failures}/${suites.length} local suites passed; external services simulated.`);
process.exitCode = failures ? 1 : 0;
