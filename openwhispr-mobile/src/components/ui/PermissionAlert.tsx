import { Modal, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { create } from 'zustand';
import { SystemIcon } from '@/components/ui/SystemIcon';

interface PermissionAlertOptions {
  title: string;
  message: string;
  primaryLabel: string;
  onPrimary: () => void;
}

interface PermissionAlertState extends PermissionAlertOptions {
  visible: boolean;
  show: (opts: PermissionAlertOptions) => void;
  hide: () => void;
}

const IDLE: PermissionAlertOptions = {
  title: '',
  message: '',
  primaryLabel: '',
  onPrimary: () => {},
};

const usePermissionAlertStore = create<PermissionAlertState>((set) => ({
  ...IDLE,
  visible: false,
  show: (opts) => set({ ...opts, visible: true }),
  hide: () => set({ visible: false }),
}));

export function showPermissionAlert(opts: PermissionAlertOptions): void {
  usePermissionAlertStore.getState().show(opts);
}

export function PermissionAlertMount() {
  const visible = usePermissionAlertStore((s) => s.visible);
  const title = usePermissionAlertStore((s) => s.title);
  const message = usePermissionAlertStore((s) => s.message);
  const primaryLabel = usePermissionAlertStore((s) => s.primaryLabel);
  const onPrimary = usePermissionAlertStore((s) => s.onPrimary);
  const hide = usePermissionAlertStore((s) => s.hide);

  const handlePrimary = () => {
    hide();
    onPrimary();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={hide}>
      <Pressable className="flex-1 items-center justify-center bg-black/40 px-10" onPress={hide}>
        <Pressable
          className="w-full max-w-[270px] overflow-hidden rounded-[14px] bg-systemBackground"
          style={{
            borderCurve: 'continuous',
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: 0.18,
            shadowRadius: 24,
            elevation: 8,
          }}
          onPress={(e) => e.stopPropagation()}
        >
          <View className="flex-row justify-end px-2 pt-2">
            <Pressable
              onPress={hide}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Close"
              className="h-7 w-7 items-center justify-center"
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <SystemIcon name="xmark" mdName="X" size={16} color="secondaryLabel" />
            </Pressable>
          </View>
          <View className="items-center px-5 pt-1 pb-5">
            <Text className="text-center text-[17px] font-semibold text-label">{title}</Text>
            <Text className="mt-1.5 text-center text-[13px] leading-[18px] text-secondaryLabel">
              {message}
            </Text>
            <Pressable
              onPress={handlePrimary}
              accessibilityRole="button"
              className="mt-[18px] w-full items-center rounded-[10px] bg-brand py-3"
              style={({ pressed }) => ({
                borderCurve: 'continuous',
                opacity: pressed ? 0.85 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              })}
            >
              <Text className="text-[15px] font-semibold text-white">{primaryLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
