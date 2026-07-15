// Do'kon reytingi — ★★★★☆ (server computeShopRating natijasi, 1..5)

type RatingStarsProps = {
  rating: number;
  className?: string;
};

export default function RatingStars({ rating, className = "" }: RatingStarsProps) {
  const r = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className={`inline-flex items-center gap-0.5 leading-none ${className}`} aria-label={`${r} / 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= r ? "text-amber-400" : "text-muted-foreground/30"}>
          ★
        </span>
      ))}
    </span>
  );
}
