import type { OnboardingStepProps } from "./OnboardingModal";
import styles from "./OnboardingModal.module.css";

export default function SetupStep({}: OnboardingStepProps) {
  return (
    <div className={styles.step}>
      <h3 className={styles.stepTitle}>Project & defaults</h3>
      <p className={styles.stepBody}>
        Add a project and pick recommended defaults
      </p>
    </div>
  );
}
