import { View } from 'react-native';

/**
 * Placeholder route — the Report tab never navigates here. Its tabBarButton
 * intercepts the press and opens the action sheet (see (tabs)/_layout.tsx),
 * mirroring the web shell where Report is a chooser, not a page.
 */
export default function ReportRoute() {
  return <View className="flex-1 bg-surface" />;
}
