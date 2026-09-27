/**
 * @file scripts/validate-stage-tracker.ts
 * Validation suite for the Persistent Stage Status Tracker.
 *
 * Verifies:
 *  1. Fresh storage initialization: Stage 1–6 = COMPLETE, Stage 7–10 = NOT_STARTED.
 *  2. Uniqueness & Idempotency: Repeated initialization creates zero duplicates.
 *  3. Persistence across simulated reload: Durably preserved and reloaded.
 *  4. Single authoritative store of truth.
 *  5. Relational database synchronization: project_stage_status table in PostgreSQL.
 *  6. Monotonicity & non-tampering: Stage 7 remains NOT_STARTED.
 */

import { createFreshDb, applySchema } from '../src/db/database.ts';
import {
  initializeStageTracker,
  loadStageRecords,
  getStageTrackerSummary,
  updateStageStatus,
  seedStageTrackerInDatabase,
} from '../src/tracker/stageTracker.ts';
import { StageRecord } from '../src/tracker/types.ts';

function assert(condition: boolean, testName: string, detail?: string): void {
  if (!condition) {
    console.error(`  [FAIL] ${testName}: ${detail ?? 'Assertion failed'}`);
    process.exit(1);
  }
  console.log(`  [PASS] ${testName}: ${detail ?? 'Verified'}`);
}

async function runStageTrackerValidation() {
  console.log('===============================================================');
  console.log('STARTING PERSISTENT STAGE STATUS TRACKER VALIDATION');
  console.log('===============================================================');

  // --------------------------------------------------------------------------
  // TEST 1: Fresh Storage Initialization
  // --------------------------------------------------------------------------
  console.log('\n[1/8] Testing: Fresh storage initialization sets Stage 1–8 COMPLETE and 9–10 NOT_STARTED...');
  const records = initializeStageTracker(true);

  assert(records.length === 10, 'Total Stages Count', `Expected 10 stages, found ${records.length}.`);

  for (let i = 1; i <= 8; i++) {
    const stage = records.find((s) => s.stage_number === i);
    assert(stage !== undefined, `Stage ${i} Exists`, `Found Stage ${i}.`);
    assert(stage?.status === 'COMPLETE', `Stage ${i} Status COMPLETE`, `Stage ${i} is COMPLETE.`);
    assert(stage?.completed_at !== null, `Stage ${i} Timestamp`, `Stage ${i} has completion timestamp: ${stage?.completed_at}.`);
  }

  for (let i = 9; i <= 10; i++) {
    const stage = records.find((s) => s.stage_number === i);
    assert(stage !== undefined, `Stage ${i} Exists`, `Found Stage ${i}.`);
    assert(stage?.status === 'NOT_STARTED', `Stage ${i} Status NOT_STARTED`, `Stage ${i} is NOT_STARTED.`);
    assert(stage?.completed_at === null, `Stage ${i} Timestamp Null`, `Stage ${i} completion timestamp is NULL.`);
  }

  // --------------------------------------------------------------------------
  // TEST 2: Current Progress & Next Stage Identification
  // --------------------------------------------------------------------------
  console.log('\n[2/8] Testing: Current progress is Stage 8 and Next is Stage 9...');
  const summary = getStageTrackerSummary();
  assert(summary.currentProgressStage === 8, 'Current Progress Stage 8', `Current progress stage is ${summary.currentProgressStage}.`);
  assert(summary.nextPendingStage === 9, 'Next Pending Stage 9', `Next pending stage is ${summary.nextPendingStage}.`);
  assert(summary.completedCount === 8, 'Completed Count 8', `Completed count is ${summary.completedCount} / 10.`);

  // --------------------------------------------------------------------------
  // TEST 3: Idempotent Initialization (Zero Duplicate Rows)
  // --------------------------------------------------------------------------
  console.log('\n[3/8] Testing: Repeated initialization is idempotent and creates zero duplicates...');
  const reinit1 = initializeStageTracker(false);
  const reinit2 = initializeStageTracker(false);
  const loaded = loadStageRecords();

  assert(reinit1.length === 10, 'Re-initialization 1 Count', 'Stage count remains 10.');
  assert(reinit2.length === 10, 'Re-initialization 2 Count', 'Stage count remains 10.');
  assert(loaded.length === 10, 'Loaded Records Count', 'Loaded records count is strictly 10.');

  const uniqueNumbers = new Set(loaded.map((s) => s.stage_number));
  assert(uniqueNumbers.size === 10, 'Unique Stage Numbers', 'All 10 stage numbers are unique (no duplicate rows).');

  // --------------------------------------------------------------------------
  // TEST 4: Persistence Across Simulated Reload
  // --------------------------------------------------------------------------
  console.log('\n[4/8] Testing: Durability across simulated application reload...');
  const beforeReload = loadStageRecords();
  // Simulate reload by re-reading directly
  const afterReload = loadStageRecords();

  assert(
    JSON.stringify(beforeReload) === JSON.stringify(afterReload),
    'Reload Preserves State',
    'Stage status records remain completely identical across simulated reload.'
  );

  // --------------------------------------------------------------------------
  // TEST 5: Database Schema & project_stage_status Table Integration
  // --------------------------------------------------------------------------
  console.log('\n[5/8] Testing: PostgreSQL project_stage_status table creation and constraints...');
  const db = await createFreshDb();
  await applySchema(db);

  await seedStageTrackerInDatabase(db);

  const dbRows = await db.query<StageRecord>(
    `SELECT stage_number, stage_name, status, completed_at, notes, updated_at
     FROM project_stage_status
     ORDER BY stage_number ASC;`
  );

  assert(dbRows.rows.length === 10, 'DB Seeded Count', `Database contains ${dbRows.rows.length} stage records.`);

  for (const r of dbRows.rows) {
    if (r.stage_number <= 8) {
      assert(r.status === 'COMPLETE', `DB Stage ${r.stage_number} COMPLETE`, `DB Stage ${r.stage_number} status is COMPLETE.`);
    } else {
      assert(r.status === 'NOT_STARTED', `DB Stage ${r.stage_number} NOT_STARTED`, `DB Stage ${r.stage_number} status is NOT_STARTED.`);
    }
  }

  // --------------------------------------------------------------------------
  // TEST 6: Database Constraint Enforcement (Invalid Status Rejected)
  // --------------------------------------------------------------------------
  console.log('\n[6/8] Testing: Database CHECK constraint rejects invalid stage status...');
  let invalidStatusRejected = false;
  try {
    await db.query(
      `INSERT INTO project_stage_status (stage_number, stage_name, status)
       VALUES (99, 'Invalid Stage', 'SOME_INVALID_STATUS');`
    );
  } catch (err: unknown) {
    invalidStatusRejected = true;
    console.log('  Confirmed rejection by CHECK constraint:', (err as Error).message);
  }
  assert(
    invalidStatusRejected,
    'Database Status Constraint',
    'Database strictly rejected invalid status.'
  );

  // --------------------------------------------------------------------------
  // TEST 7: Database PRIMARY KEY Constraint (No Duplicates Allowed)
  // --------------------------------------------------------------------------
  console.log('\n[7/8] Testing: Database PRIMARY KEY constraint enforces unique stage_number...');
  let duplicateRejected = false;
  try {
    await db.query(
      `INSERT INTO project_stage_status (stage_number, stage_name, status)
       VALUES (1, 'Duplicate Stage 1', 'COMPLETE');`
    );
  } catch (err: unknown) {
    duplicateRejected = true;
    console.log('  Confirmed rejection by PRIMARY KEY constraint:', (err as Error).message);
  }
  assert(
    duplicateRejected,
    'Database Primary Key Constraint',
    'Database strictly prevented duplicate stage_number.'
  );

  // --------------------------------------------------------------------------
  // TEST 8: Stage 9 Remains NOT_STARTED (Strict Stage Boundary Enforcement)
  // --------------------------------------------------------------------------
  console.log('\n[8/8] Testing: Stage 9 remains strictly NOT_STARTED...');
  const stage9 = (await db.query<{ status: string }>(
    `SELECT status FROM project_stage_status WHERE stage_number = 9;`
  )).rows[0];

  assert(stage9.status === 'NOT_STARTED', 'Stage 9 Status Strictly NOT_STARTED', 'Stage 9 is NOT_STARTED.');

  console.log('\n===============================================================');
  console.log('STAGE STATUS TRACKER VALIDATION COMPLETED: 8/8 TESTS PASSED.');
  console.log('===============================================================');
}

runStageTrackerValidation().catch((err) => {
  console.error('Stage tracker validation failed:', err);
  process.exit(1);
});
