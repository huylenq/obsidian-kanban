import assert from 'node:assert/strict';
import {
  archivePathForTask,
  shouldArchiveDoneTask,
} from '../src/huyTaskArchive';

assert.equal(
  shouldArchiveDoneTask({ status: 'Done', updated: '2026-06-01' }, '2026-06-18', 14),
  true,
  'Done tasks older than threshold should archive'
);

assert.equal(
  shouldArchiveDoneTask({ status: 'Done', updated: '2026-06-15' }, '2026-06-18', 14),
  false,
  'Recent Done tasks should not archive'
);

assert.equal(
  shouldArchiveDoneTask({ status: 'Todo', updated: '2026-06-01' }, '2026-06-18', 14),
  false,
  'Non-Done tasks should not archive'
);

assert.equal(
  shouldArchiveDoneTask({ status: 'Done' }, '2026-06-18', 14),
  false,
  'Tasks without a date should not be archived automatically'
);

assert.deepEqual(
  archivePathForTask('Aitomatic/Tasks/Foo.md', '2026-06-18'),
  { folder: 'Aitomatic/Tasks/Archive/2026', path: 'Aitomatic/Tasks/Archive/2026/Foo.md' },
  'Archive path should be grouped by archive year'
);

console.log('huyTaskArchive tests passed');
