import { Stack, useLocalSearchParams } from 'expo-router';

import { DeskScreen } from '@/desk/DeskScreen';

/** File desk (D-360): desk files, version stack, and toolbar. Page draws its own top bar (undo, redo, finish). */
export default function DeskRoute() {
  const { deskId } = useLocalSearchParams<{ deskId: string }>();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <DeskScreen key={deskId} deskId={deskId} />
    </>
  );
}
