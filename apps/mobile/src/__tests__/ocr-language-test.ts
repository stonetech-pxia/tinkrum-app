import { autoOcrLanguage } from '../runtime/ocr-language';

// Automatic text recognition language (D-278): Selects the first language from the phone's language list, falling back to the interface language if unavailable.

describe('automatic text recognition language', () => {
  it('follows the first phone language', () => {
    expect(autoOcrLanguage(['zh-Hans-CN', 'en-US'], 'en')).toBe('chi_sim');
    expect(autoOcrLanguage(['zh-Hant-TW'], 'zh')).toBe('chi_tra');
    expect(autoOcrLanguage(['zh-HK'], 'zh')).toBe('chi_tra');
    expect(autoOcrLanguage(['fr-FR', 'zh-Hans'], 'zh')).toBe('fra');
    expect(autoOcrLanguage(['ja-JP'], 'en')).toBe('jpn');
  });

  it('picks the system engines for Korean, Russian and Vietnamese phones', () => {
    expect(autoOcrLanguage(['ko-KR'], 'en')).toBe('kor');
    expect(autoOcrLanguage(['ru-RU'], 'en')).toBe('rus');
    expect(autoOcrLanguage(['vi-VN'], 'en')).toBe('vie');
  });

  it('falls back to the interface language, then English', () => {
    expect(autoOcrLanguage([], 'zh')).toBe('chi_sim');
    expect(autoOcrLanguage([], 'fr')).toBe('fra');
    expect(autoOcrLanguage(['th-TH'], 'zh')).toBe('eng');
  });
});
