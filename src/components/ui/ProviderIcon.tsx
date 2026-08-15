import { Brain, Wrench, HardDrive } from "lucide-react";
import { getProviderIcon, isMonochromeProvider } from "@/utils/providerIcons";

interface ProviderIconProps {
  provider: string;
  className?: string;
  forceLight?: boolean;
  monochrome?: boolean;
}

export function ProviderIcon({
  provider,
  className = "w-5 h-5",
  forceLight = false,
  monochrome = false,
}: ProviderIconProps) {
  if (provider === "custom") {
    return <Wrench className={className} />;
  }

  if (provider === "local") {
    return <HardDrive className={className} />;
  }

  const iconUrl = getProviderIcon(provider);

  if (!iconUrl) {
    return <Brain className={className} />;
  }

  const isMonochrome = isMonochromeProvider(provider);

  return (
    <img
      src={iconUrl}
      alt={`${provider} icon`}
      className={`${className} ${isMonochrome ? "icon-monochrome" : ""} ${forceLight && isMonochrome ? "dark:invert-0!" : ""} ${monochrome ? "onboarding-provider-icon-monochrome" : ""}`}
    />
  );
}
