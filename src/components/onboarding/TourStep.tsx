import type { OnboardingStepProps } from "./OnboardingModal";
import styles from "./OnboardingModal.module.css";

export default function TourStep(_props: OnboardingStepProps) {
  return (
    <div className={styles.step}>
      <h3 className={styles.stepTitle}>Tour</h3>
      <p className={styles.stepBody}>What Solenta can do</p>
    </div>
  );
}
