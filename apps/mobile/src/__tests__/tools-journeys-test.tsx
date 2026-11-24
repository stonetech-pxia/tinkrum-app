import { fireEvent } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

import { renderToolsApp } from '../test-utils/render-app';

// Built-in tool interface journeys: install -> open tool page -> run single-function workflow -> result page actions.

describe('tool journeys (UI)', () => {
  afterEach(() => jest.restoreAllMocks());

  async function installImageTool() {
    const app = await renderToolsApp();
    await fireEvent.press(screen.getByTestId('nav-tools'));
    await fireEvent.press(await screen.findByTestId('install-image'));
    await fireEvent.press(await screen.findByTestId('open-image'));
    return app;
  }

  it('compresses photos from the image tool page and saves them only when asked', async () => {
    const { files, repo } = await installImageTool();
    // Tool page features are arranged in a grid; the entire block is tappable, with no separate
    // "Start" button (D-108). Fixed settings are displayed on the tile; runtime prompts are not
    // listed.
    expect(await screen.findByText('压缩图片')).toBeTruthy();
    expect(screen.getByText('格式：JPG')).toBeTruthy();
    expect(screen.queryAllByText('开始')).toEqual([]);

    files.nextPhotos = [
      files.offerImage('IMG_1.HEIC', 4032, 3024, 'image/heic', new Uint8Array(2_000_000)),
    ];
    await fireEvent.press(screen.getByTestId('run-image-compress'));
    // Runtime prompt for target size: tap "240 KB" and confirm.
    await fireEvent.press(await screen.findByTestId('ask-preset-kb-240'));
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    expect(await screen.findByTestId('result-item-IMG_1.jpg')).toBeTruthy();
    // Shrunken: displays original and current sizes.
    expect(screen.getByTestId('result-smaller')).toHaveTextContent(/^原来 .+，现在 .+$/);
    expect(await repo.listAssets()).toEqual([]);

    await fireEvent.press(screen.getByTestId('result-save'));
    expect(await screen.findByText('已存到 Tinkrum · IMG_1.jpg')).toBeTruthy();
    expect((await repo.listAssets()).map((a) => a.name)).toEqual(['IMG_1.jpg']);
    expect((await repo.listAssets())[0]!.size).toBeLessThanOrEqual(240 * 1024);

    await fireEvent.press(screen.getByTestId('result-photos'));
    expect(files.savedToPhotos).toHaveLength(1);

    // "Done" closes the run page and returns to the tool page (D-111).
    expect(screen.getByTestId('run-done')).toHaveTextContent('完成');
    await fireEvent.press(screen.getByTestId('run-done'));
    expect(screen.queryByTestId('run-done')).toBeNull();
    expect(await screen.findByTestId('run-image-compress')).toBeTruthy();
  });

  it('shares every result in one sheet and saves them to a remembered folder from the result page', async () => {
    const { files } = await installImageTool();
    files.nextPhotos = [
      files.offerImage('a.jpg', 400, 300),
      files.offerImage('b.jpg', 400, 300),
      files.offerImage('c.jpg', 400, 300),
    ];
    await fireEvent.press(screen.getByTestId('run-image-compress'));
    await fireEvent.press(await screen.findByTestId('ask-preset-kb-240'));
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    expect(await screen.findByTestId('result-item-c.jpg')).toBeTruthy();

    // Include three files in a single share sheet (D-119).
    await fireEvent.press(screen.getByTestId('result-share'));
    expect(files.shareSheets.map((sheet) => sheet.length)).toEqual([3]);

    // Dismiss folder picker: neither saved nor errored.
    files.folderChoice = 'cancel';
    await fireEvent.press(screen.getByTestId('result-folder'));
    expect(screen.getByText('存到手机')).toBeTruthy();
    expect(files.folders.size).toBe(0);

    files.folderChoice = 'notWritable';
    await fireEvent.press(screen.getByTestId('result-folder'));
    expect(await screen.findByText('不能存进这个文件夹，请换一个文件夹再试。')).toBeTruthy();

    files.folderChoice = 'pick';
    await fireEvent.press(screen.getByTestId('result-folder'));
    expect(await screen.findByText('已存到「MorphOut」')).toBeTruthy();
    expect([...files.folders.get('MorphOut')!.keys()]).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(files.folderPicks).toBe(3);

    // Change folder: prompt picker again, and remember the new one henceforth.
    files.nextFolder = 'Receipts';
    await fireEvent.press(screen.getByTestId('result-folderChange'));
    expect(await screen.findByText('已存到「Receipts」')).toBeTruthy();
    expect(files.folderPicks).toBe(4);
    expect(files.remembered).toBe('Receipts');

    // iOS "On My iPhone" layer is named File Provider Storage in the file system; displayed according to the "Files" app name (D-583).
    files.nextFolder = 'File Provider Storage';
    await fireEvent.press(screen.getByTestId('result-folderChange'));
    expect(await screen.findByText('已存到「我的 iPhone」')).toBeTruthy();
  });

  it('offers the remembered folder by name on the result page', async () => {
    const { files } = await installImageTool();
    files.remembered = 'MorphOut';
    files.nextPhotos = [files.offerImage('a.jpg', 400, 300)];
    await fireEvent.press(screen.getByTestId('run-image-compress'));
    await fireEvent.press(await screen.findByTestId('ask-preset-kb-240'));
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    expect(await screen.findByText('存到「MorphOut」')).toBeTruthy();
    expect(screen.getByText('换文件夹')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('result-folder'));
    expect(await screen.findByText('已存到「MorphOut」')).toBeTruthy();
    // Saved directly without prompting the picker.
    expect(files.folderPicks).toBe(0);
  });

  it('a wrong value in the question is caught before running', async () => {
    const { files } = await installImageTool();
    files.nextPhotos = [files.offerImage('a.jpg', 400, 300)];
    await fireEvent.press(await screen.findByTestId('run-image-compress'));
    await fireEvent.changeText(await screen.findByTestId('ask-maxKB'), '5');
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    expect(await screen.findByText('请检查：不超过')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('prompt-cancel'));
    expect(await screen.findByTestId('run-cancelled')).toBeTruthy();
  });

  it('asks for the Wi-Fi password in a hidden field and never saves it (D-199)', async () => {
    const { repo } = await renderToolsApp();
    await fireEvent.press(screen.getByTestId('nav-tools'));
    await fireEvent.press(await screen.findByTestId('install-qr'));
    await fireEvent.press(await screen.findByTestId('open-qr'));
    await fireEvent.press(await screen.findByTestId('run-qr-wifi'));
    await fireEvent.changeText(await screen.findByTestId('ask-network'), 'Home');
    const password = screen.getByTestId('ask-password');
    expect(password.props.secureTextEntry).toBe(true);
    // Password left blank: runtime error, no useless code generated.
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    expect(await screen.findByText('没有填密码。')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('run-again'));
    await fireEvent.changeText(await screen.findByTestId('ask-network'), 'Home');
    await fireEvent.changeText(screen.getByTestId('ask-password'), 'secret123');
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    expect(await screen.findByTestId('result-share')).toBeTruthy();
    const head = await repo.getHead();
    expect(JSON.stringify(head!.config)).not.toContain('secret123');
  });

  it('removes and adds PDF passwords: a password screen per file, the new password typed twice (D-194)', async () => {
    const { files } = await renderToolsApp();
    await fireEvent.press(screen.getByTestId('nav-tools'));
    await fireEvent.press(await screen.findByTestId('install-pdf'));
    await fireEvent.press(await screen.findByTestId('open-pdf'));
    const pdf = (body: string) => files.offer('工资单.pdf', new TextEncoder().encode(body));

    files.nextPick = [pdf('%LOCK:1234\n%PDF 工资')];
    await fireEvent.press(await screen.findByTestId('run-pdf-unlock'));
    await fireEvent.changeText(await screen.findByTestId('password-input'), 'nope');
    await fireEvent.press(screen.getByTestId('local-done'));
    expect(await screen.findByTestId('password-wrong')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('password-input'), '1234');
    await fireEvent.press(screen.getByTestId('local-done'));
    expect(await screen.findByTestId('result-share')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('run-done'));

    files.nextPick = [pdf('%PDF 工资')];
    await fireEvent.press(await screen.findByTestId('run-pdf-protect'));
    await fireEvent.changeText(await screen.findByTestId('ask-password'), 'abc');
    await fireEvent.changeText(screen.getByTestId('ask-password-again'), 'abd');
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    expect(await screen.findByText('两次输入的密码不一样。')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('ask-password-again'), 'abc');
    await fireEvent.press(screen.getByTestId('prompt-ok'));
    expect(await screen.findByTestId('result-share')).toBeTruthy();
  });
});
