import { View } from 'react-native';
import { Text } from '@/components/ui/Text';

interface InstructionOverlayProps {
  title?: string;
  steps: string[];
}

const SURFACE_BG = '#1C1C1E';
const SURFACE_BORDER = '#2C2C2E';
const STEP_BG = 'rgba(0, 122, 255, 0.18)';
const STEP_NUMBER = '#0A84FF';

export function InstructionOverlay({ title, steps }: InstructionOverlayProps) {
  return (
    <View
      className="w-full overflow-hidden rounded-xl border px-4 py-4"
      style={{ backgroundColor: SURFACE_BG, borderColor: SURFACE_BORDER }}
    >
      {title ? (
        <Text className="mb-3 text-[12px] font-medium uppercase tracking-wide text-white/60">
          {title}
        </Text>
      ) : null}
      <View className="gap-3">
        {steps.map((step, index) => (
          <View key={step} className="flex-row items-start">
            <View
              className="mr-3 h-6 w-6 items-center justify-center rounded-full"
              style={{ backgroundColor: STEP_BG }}
            >
              <Text className="text-[12px] font-semibold" style={{ color: STEP_NUMBER }}>
                {index + 1}
              </Text>
            </View>
            <Text className="flex-1 text-[15px] leading-[20px] text-white">{step}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
