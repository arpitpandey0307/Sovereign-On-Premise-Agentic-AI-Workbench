import { Construction } from "lucide-react";
import { EmptyState } from "@/components/states/EmptyState";

/**
 * A screen that belongs to a later part.
 *
 * It says which part it is waiting for rather than pretending to be empty --
 * an unfinished screen and a screen with no data look identical otherwise,
 * and that ambiguity wastes someone's afternoon.
 */
export function Placeholder({ name, part }: { name: string; part: string }) {
  return (
    <EmptyState
      className="h-full"
      icon={<Construction />}
      title={`${name} is not built yet`}
      description={`This screen arrives in ${part}. The shell, routing and permissions around it are in place.`}
    />
  );
}
