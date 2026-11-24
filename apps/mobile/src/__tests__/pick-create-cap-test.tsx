import { fireEvent } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { openPicker, put } from '../test-utils/pick-fixtures';

// Check-to-create (D-616) allows checking at most MAX_CREATE_ALL items (200, D-567) at a time. In
// tests, limit is changed to 3 to verify that after reaching the limit, other items cannot be
// checked and an upper limit message is shown; unchecking one allows checking again. The limit of
// 200 itself is guarded by core's invariants.test.ts.
jest.mock('@morph/core', () => ({ ...jest.requireActual('@morph/core'), MAX_CREATE_ALL: 3 }));

it('stops at the cap: the other rows can’t be checked and the hint says so', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'r1', 'recipes', { name: '松饼' });
  for (let i = 1; i <= 5; i++) await put(repo, `i${i}`, 'ingredients', { name: `食材${i}` });
  await openPicker(repo);
  for (const id of ['i1', 'i2', 'i3'])
    await fireEvent.press(await screen.findByTestId(`pick-row-${id}`));
  expect(screen.getByTestId('pick-records-add')).toHaveTextContent('添加 3 条到「菜谱用料」');
  expect(screen.getByText('一次最多 3 条。')).toBeTruthy();
  expect(screen.getByTestId('pick-row-i4')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('pick-row-i2'));
  expect(screen.getByTestId('pick-row-i4')).not.toBeDisabled();
  await fireEvent.press(screen.getByTestId('pick-row-i4'));
  expect(screen.getByTestId('pick-records-add')).toHaveTextContent('添加 3 条到「菜谱用料」');
});
