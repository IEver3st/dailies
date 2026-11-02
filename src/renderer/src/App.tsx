import { useEffect, useState } from "react";
import { Library, type OpenTarget } from "./components/Library";
import { Review } from "./components/Review";
import { connection } from "./lib/api";

export function App() {
  const [target, setTarget] = useState<OpenTarget | undefined>(() => {
    const id = new URL(location.href).searchParams.get("cut");
    return id ? { cutId: id } : undefined;
  });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    connection()
      .then(() => setReady(true))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    void window.dailies?.takeNavigation().then((id) => id && setTarget({ cutId: id }));
    return window.dailies?.onNavigate((id) => setTarget({ cutId: id }));
  }, []);

  if (error) {
    return (
      <div className="grid h-full place-items-center p-10">
        <div className="max-w-md">
          <div className="text-[17px] font-semibold">Dailies could not reach its render service</div>
          <p className="mt-2 text-soft">{error}</p>
        </div>
      </div>
    );
  }
  if (!ready) return <div className="drag h-12" />;
  return target ? <Review key={`${target.cutId}-${target.rev}-${target.t}`} cutId={target.cutId} start={target} onBack={() => setTarget(undefined)} /> : <Library onOpen={setTarget} />;
}
