import { DEFAULT_THEME } from '@morph/core';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { CloseButton } from '../shell/CloseButton';
import { makePalette } from '../renderer/theme';

const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = false;
jest.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => mockCanGoBack, back: mockBack, replace: mockReplace }),
}));
jest.mock('../workspace/context', () => ({ useWorkspaceContext: () => ({ locale: 'en' }) }));

beforeEach(() => {
  mockBack.mockClear();
  mockReplace.mockClear();
});

it('a cold-start import link can close to home when there is no previous screen', async () => {
  mockCanGoBack = false;
  await render(<CloseButton palette={makePalette(DEFAULT_THEME, false)} />);
  await fireEvent.press(screen.getByTestId('modal-close'));
  expect(mockReplace).toHaveBeenCalledWith('/');
  expect(mockBack).not.toHaveBeenCalled();
});

it('a pushed screen still returns to the preceding screen', async () => {
  mockCanGoBack = true;
  await render(<CloseButton palette={makePalette(DEFAULT_THEME, false)} />);
  await fireEvent.press(screen.getByTestId('modal-close'));
  expect(mockBack).toHaveBeenCalledTimes(1);
});
