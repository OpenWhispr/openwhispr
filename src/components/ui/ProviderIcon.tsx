import { Brain, Wrench, HardDrive } from "lucide-react";
import { getProviderIcon, isMonochromeProvider } from "@/utils/providerIcons";

interface ProviderIconProps {
  provider: string;
  className?: string;
}

export function ProviderIcon({ provider, className = "w-5 h-5" }: ProviderIconProps) {
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
      className={`${className} ${isMonochrome ? "icon-monochrome" : ""}`}
    />
  );
}
