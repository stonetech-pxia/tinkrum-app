import { fireEvent, within } from '@testing-library/react-native';
import { screen } from 'expo-router/testing-library';

// When the desk toolbar has multiple groups, only the selected group is laid out below: tests must tap the tab above first.

const tabCount = () => screen.queryAllByTestId(/^desk-tab-\d+$/).length;

/** Tools (testID) within each group, concatenated in tab order. */
export async function allDeskTools(): Promise<string[]> {
  const ids = () =>
    within(screen.getByTestId('desk-toolbar'))
      .queryAllByTestId(/^desk-tool-/)
      .map((n) => String(n.props.testID));
  const n = tabCount();
  if (n === 0) return ids();
  const all: string[] = [];
  for (let i = 0; i < n; i++) {
    await fireEvent.press(screen.getByTestId(`desk-tab-${i}`));
    all.push(...ids());
  }
  await fireEvent.press(screen.getByTestId('desk-tab-0'));
  return all;
}

/** Tap the tab containing this tool and return the tool. */
export async function deskTool(testId: string) {
  await screen.findByTestId('desk-toolbar');
  const n = tabCount();
  for (let i = 0; i < n; i++) {
    const found = screen.queryByTestId(testId);
    if (found) return found;
    await fireEvent.press(screen.getByTestId(`desk-tab-${i}`));
  }
  return screen.getByTestId(testId);
}
