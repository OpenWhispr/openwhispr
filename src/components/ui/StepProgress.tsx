import React from "react";
import { Check, LucideIcon } from "lucide-react";

interface Step {
  title: string;
  icon: LucideIcon;
}

interface StepProgressProps {
  steps: Step[];
  currentStep: number;
  className?: string;
}

export default function StepProgress({ steps, currentStep, className = "" }: StepProgressProps) {
  return (
    <div className={`flex items-center justify-center gap-0.5 ${className}`}>
      {steps.map((step, index) => {
        const Icon = step.icon;
        const isActive = index === currentStep;
        const isCompleted = index < currentStep;

        return (
          <React.Fragment key={index}>
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors duration-150 ${
                isActive
                  ? "bg-primary/10 text-primary"
                  : isCompleted
                    ? "text-success"
                    : "text-muted-foreground/40"
              }`}
            >
              <div
                className={`w-4.5 h-4.5 rounded-md flex items-center justify-center shrink-0 transition-colors duration-150 ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : isCompleted
                      ? "bg-success/15 text-success"
                      : "bg-muted text-muted-foreground/40"
                }`}
              >
                {isCompleted ? (
                  <Check className="w-2.5 h-2.5" strokeWidth={3} />
                ) : (
                  <Icon className="w-2.5 h-2.5" />
                )}
              </div>
              <span
                className={`text-xs font-medium hidden md:block tracking-wide ${
                  isActive
                    ? "text-primary"
                    : isCompleted
                      ? "text-success"
                      : "text-muted-foreground/40"
                }`}
              >
                {step.title}
              </span>
            </div>
            {index < steps.length - 1 && (
              <div
                className={`w-3 h-px mx-0.5 transition-colors duration-150 ${
                  isCompleted ? "bg-success/40" : "bg-border"
                }`}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
