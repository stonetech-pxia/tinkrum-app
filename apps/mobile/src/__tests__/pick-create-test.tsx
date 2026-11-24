import { fireEvent, waitFor } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { openPicker, put } from '../test-utils/pick-fixtures';

// Check-to-create (D-616, founder 2026-11-21 "Kickoff"): "Add ingredient" under the "Recipe
// ingredients" list on the recipe page opens the selection page, where several ingredients are
// checked, creating an entry for each, linking the recipe and that ingredient; those already in
// this recipe display "Added". The "Add N items to..." button clearly states the count and table,
// acting as the initial question (invariant 11, founder 2026-11-21 "Counts, remove the second
// one"), tapping it creates directly without popping confirmation; upon completion, returns to the
// recipe page, and the toast can undo this batch. Checking without tapping writes nothing
// (invariant 15).

async function withPantry() {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'r1', 'recipes', { name: '松饼' });
  await put(repo, 'r2', 'recipes', { name: '汤' });
  for (const [id, name] of [
    ['flour', '面粉'],
    ['egg', '鸡蛋'],
    ['milk', '牛奶'],
    ['salt', '盐'],
  ])
    await put(repo, id!, 'ingredients', { name });
  await put(repo, 'x1', 'recipe-items', { recipe: 'r1', ingredient: 'flour', amount: 200 });
  // Other recipes use eggs: not yet in this recipe.
  await put(repo, 'x2', 'recipe-items', { recipe: 'r2', ingredient: 'egg', amount: 2 });
  return repo;
}

const noAlert = () => jest.spyOn(Alert, 'alert').mockImplementation(() => {});
afterEach(() => jest.restoreAllMocks());

const recipeItems = async (repo: MemoryWorkspaceRepo) =>
  (await repo.listRecords('recipe-items'))
    .map((r) => r.values)
    .sort((a, b) => String(a.ingredient).localeCompare(String(b.ingredient)));

it('a new user with no ingredients is told to add some first, and nothing can be picked', async () => {
  const repo = new MemoryWorkspaceRepo();
  await put(repo, 'r1', 'recipes', { name: '松饼' });
  await openPicker(repo);
  expect(await screen.findByTestId('pick-records-empty')).toHaveTextContent(
    '「食材」还没有记录，先去那里加几条。',
  );
  expect(screen.getByTestId('pick-records-add')).toBeDisabled();
});

it('shows what this recipe already has; the button says how many and where, and creates them with no second question', async () => {
  const repo = await withPantry();
  const router = await openPicker(repo);
  // Flour is already in this recipe: displays "Added", cannot be checked again. Eggs are only in other recipes and can be checked.
  const flour = await screen.findByTestId('pick-row-flour');
  expect(flour).toHaveTextContent(/已添加/);
  expect(flour).toBeDisabled();
  expect(screen.getByTestId('pick-row-egg')).not.toHaveTextContent(/已添加/);
  expect(screen.getByTestId('pick-records-add')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('pick-row-salt'));
  await fireEvent.press(screen.getByTestId('pick-row-egg'));
  expect(screen.getByTestId('pick-records-add')).toHaveTextContent('添加 2 条到「菜谱用料」');
  // Checked but not yet tapped: nothing is written (invariant 15).
  expect(await repo.listRecords('recipe-items')).toHaveLength(2);
  const alert = noAlert();
  await fireEvent.press(screen.getByTestId('pick-records-add'));
  await waitFor(() => expect(router.getPathname()).toBe('/page/recipe'));
  expect(await screen.findByTestId('toast')).toHaveTextContent(/已在「菜谱用料」新建 2 条记录/);
  expect(screen.getByTestId('toast-undo')).toBeTruthy();
  expect(alert).not.toHaveBeenCalled();
  expect(await recipeItems(repo)).toEqual(
    [
      { recipe: 'r2', ingredient: 'egg', amount: 2 },
      { recipe: 'r1', ingredient: 'egg' },
      { recipe: 'r1', ingredient: 'flour', amount: 200 },
      { recipe: 'r1', ingredient: 'salt' },
    ].sort((a, b) => a.ingredient.localeCompare(b.ingredient)),
  );
});

it('undo removes exactly the entries this pick created', async () => {
  const repo = await withPantry();
  await openPicker(repo);
  await fireEvent.press(await screen.findByTestId('pick-row-milk'));
  await fireEvent.press(screen.getByTestId('pick-row-salt'));
  await fireEvent.press(screen.getByTestId('pick-records-add'));
  await fireEvent.press(await screen.findByTestId('toast-undo'));
  await waitFor(async () =>
    expect((await repo.listRecords('recipe-items')).map((r) => r.id).sort()).toEqual(['x1', 'x2']),
  );
});

it('searches when there are many, and French uses entrée in the singular', async () => {
  const repo = await withPantry();
  for (let i = 1; i <= 8; i++) await put(repo, `spice${i}`, 'ingredients', { name: `épice ${i}` });
  await openPicker(repo, 'fr');
  await fireEvent.changeText(await screen.findByTestId('pick-records-search'), 'sel');
  expect(screen.queryByTestId('pick-row-milk')).toBeNull();
  // "Salt" name is in Chinese, searching for "sel" finds nothing: report when there is no match.
  expect(screen.getByTestId('pick-records-empty')).toHaveTextContent(
    'Aucune entrée ne correspond.',
  );
  await fireEvent.changeText(screen.getByTestId('pick-records-search'), 'épice 3');
  await fireEvent.press(await screen.findByTestId('pick-row-spice3'));
  expect(screen.getByTestId('pick-records-add')).toHaveTextContent(
    'Ajouter 1 entrée à « 菜谱用料 »',
  );
  const alert = noAlert();
  await fireEvent.press(screen.getByTestId('pick-records-add'));
  await waitFor(async () => expect(await repo.listRecords('recipe-items')).toHaveLength(3));
  expect(alert).not.toHaveBeenCalled();
});
