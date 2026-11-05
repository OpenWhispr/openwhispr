import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AccountButton } from '@/android/ui';
import { formatLibraryTime } from '@/android/libraryTime';
import { confirmDestructive } from '@/lib/alerts';
import { createDictionaryScreen } from './DictionaryScreenCore';

const DictionaryScreen = createDictionaryScreen({
  useCopy: useAndroidCopy,
  ModeToggle: function ModeToggle({ mode, onChange }) {
    const { t } = useTranslation();
    return (
      <View style={{ marginHorizontal: 20, marginTop: 16, marginBottom: 8 }}>
        <SegmentedControl
          value={mode}
          onChange={onChange}
          options={[
            { value: 'words', label: t('dictionaryWords') },
            { value: 'snippets', label: t('dictionarySnippets') },
          ]}
        />
      </View>
    );
  },
  headerProps: () => ({ right: <AccountButton /> }),
  useRowPresentation(entry, hiddenForYou, onDelete) {
    const { copy, language } = useAndroidCopy();
    const name =
      entry.source === 'manual'
        ? copy('library.manual', 'Manual')
        : copy('library.learned', 'Learned');
    const sourceLabel = entry.addedAt
      ? `${name} · ${formatLibraryTime(entry.addedAt, language)}`
      : name;
    const label = hiddenForYou
      ? `${sourceLabel} · ${copy('library.hiddenForYou', 'Hidden for you')}`
      : sourceLabel;
    return {
      label,
      numberOfLines: undefined,
      viewProps: {
        accessible: true,
        accessibilityLabel: `${entry.word}, ${label}`,
        accessibilityActions: [{ name: 'delete', label: copy('deleteAction', 'Delete') }],
        onAccessibilityAction: ({ nativeEvent }) => {
          if (nativeEvent.actionName === 'delete')
            confirmDestructive(
              copy('library.deleteWord', 'Delete word?'),
              copy('library.deleteNamed', `"${entry.word}" will be deleted.`, { name: entry.word }),
              onDelete,
              {
                cancelLabel: copy('cancel', 'Cancel'),
                destructiveLabel: copy('deleteAction', 'Delete'),
              },
            );
        },
      },
    };
  },
});

export default DictionaryScreen;
