import { useState } from 'react';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="min-h-screen bg-wh40k-darker text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-6xl font-display text-wh40k-accent mb-4">
          ⚔️ 40K Tier List
        </h1>
        <p className="text-xl text-gray-300 mb-8">
          Auto-generated unit rankings based on mathematical analysis
        </p>
        
        <div className="bg-wh40k-dark rounded-lg p-8 max-w-md mx-auto">
          <p className="text-lg mb-4">
            Counter: <span className="font-bold text-wh40k-gold">{count}</span>
          </p>
          <button
            onClick={() => setCount(count + 1)}
            className="px-6 py-3 bg-wh40k-accent hover:bg-red-600 rounded-lg font-semibold transition-colors"
          >
            Click to test
          </button>
        </div>

        <p className="mt-8 text-sm text-gray-500">
          Project setup complete! Ready for data integration.
        </p>
      </div>
    </div>
  );
}

export default App;