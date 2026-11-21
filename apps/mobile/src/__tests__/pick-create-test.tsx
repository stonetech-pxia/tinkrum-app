import { fireEvent, waitFor } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';
import { Alert } from 'react-native';

import { MemoryWorkspaceRepo } from '../storage/memory';
import { openPicker, put } from '../test-utils/pick-fixtures';

// 勾选新建（D-616，创始人 2026-11-21「开工」）：菜谱页上「菜谱用料」列表下面的「添加食材」打开勾选页面，勾几样食材，
// 每样建一条用料，连着这个菜谱和那样食材；已经在这个菜谱里的显示「已添加」。「添加 N 条到…」这个按钮写明了条数和表，
// 它就是先问的那一句（底线 11，创始人 2026-11-21「算，去掉第二次」），点了直接建，不再弹确认；建好了回到菜谱页，
// 提示条能撤回这一批。只勾不点什么都不写（底线 15）。

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
  // 别的菜谱用了鸡蛋：这个菜谱里还没有。
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
  // 面粉已经在这个菜谱里：显示「已添加」，不能再勾。鸡蛋只在别的菜谱里，能勾。
  const flour = await screen.findByTestId('pick-row-flour');
  expect(flour).toHaveTextContent(/已添加/);
  expect(flour).toBeDisabled();
  expect(screen.getByTestId('pick-row-egg')).not.toHaveTextContent(/已添加/);
  expect(screen.getByTestId('pick-records-add')).toBeDisabled();
  await fireEvent.press(screen.getByTestId('pick-row-salt'));
  await fireEvent.press(screen.getByTestId('pick-row-egg'));
  expect(screen.getByTestId('pick-records-add')).toHaveTextContent('添加 2 条到「菜谱用料」');
  // 勾了还没点：什么都没写（底线 15）。
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
  // 「盐」的名字是中文，搜「sel」找不到：没有匹配的说一句。
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
