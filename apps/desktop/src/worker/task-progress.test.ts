import { expect, it } from 'vitest';
import { TaskProgress } from './task-progress.js';

it('counts turns without new observations rather than proposal count', () => {
  const progress = new TaskProgress();
  for (let index = 0; index < 10; index++) progress.endTurn();
  expect(progress.stalled).toBe(true);
  expect(progress.idleTurns).toBe(10);
});
it('allows successive new pages but repeated pages do not reset the idle-turn counter', () => {
  const progress = new TaskProgress();
  for (let page = 0; page < 20; page++) { progress.observe('log', `host/log/page:${page}`); progress.endTurn(); }
  expect(progress.idleTurns).toBe(0);
  for (let index = 0; index < 10; index++) { progress.observe('log', 'host/log/page:19'); progress.endTurn(); }
  expect(progress.stalled).toBe(true);
});
it('retains observed fingerprints across explicit continuation instead of treating old pages as new', () => {
  const progress = new TaskProgress(); progress.observe('local', 'file:hash:0-100'); progress.endTurn();
  progress.reset(); progress.observe('local', 'file:hash:0-100'); progress.endTurn();
  expect(progress.idleTurns).toBe(1);
  progress.observe('clarification', 'answered-choice'); progress.endTurn();
  expect(progress.idleTurns).toBe(0);
});
it('bounds its index without evicting entries and making replay look like progress', () => {
  const progress = new TaskProgress(2);
  progress.observe('observation', 'one'); progress.observe('observation', 'two');
  expect(() => progress.observe('observation', 'three')).toThrow('进展索引');
  progress.observe('observation', 'one'); progress.endTurn(); progress.endTurn();
  expect(progress.idleTurns).toBe(1);
});
