import type { OnboardingStepProps } from "./OnboardingModal";
import styles from "./OnboardingModal.module.css";

export default function CliStep({}: OnboardingStepProps) {
  return (
    <div className={styles.step}>
      <h3 className={styles.stepTitle}>Agent CLIs</h3>
      <p className={styles.stepBody}>
        Check which agent CLIs are installed
      </p>
    </div>
  );
}
