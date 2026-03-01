/**
 * Shared venue coordinate map for NYC venues and parks.
 * Used by all sources (RA, Skint, Nonsense NYC, Oh My Rockness, Tavily, NYC Parks)
 * to resolve venue names → lat/lng when structured geo data is missing.
 */

const VENUE_MAP = {
  // === Bushwick / East Williamsburg ===
  'Nowadays': { lat: 40.7061, lng: -73.9212 },
  'Elsewhere': { lat: 40.7013, lng: -73.9225 },
  'Knockdown Center': { lat: 40.7150, lng: -73.9135 },
  'Brooklyn Mirage': { lat: 40.7060, lng: -73.9225 },
  'Avant Gardner': { lat: 40.7060, lng: -73.9225 },
  'The Brooklyn Mirage': { lat: 40.7060, lng: -73.9225 },
  'Jupiter Disco': { lat: 40.7013, lng: -73.9207 },
  'Bossa Nova Civic Club': { lat: 40.7065, lng: -73.9214 },
  'House of Yes': { lat: 40.7048, lng: -73.9230 },
  'Mood Ring': { lat: 40.7053, lng: -73.9211 },
  'Market Hotel': { lat: 40.7058, lng: -73.9216 },
  'Sustain': { lat: 40.7028, lng: -73.9273 },
  'H0L0': { lat: 40.7087, lng: -73.9246 },
  'Rubulad': { lat: 40.6960, lng: -73.9270 },
  'The Sultan Room': { lat: 40.7058, lng: -73.9216 },
  'The Meadows': { lat: 40.7058, lng: -73.9216 },
  'Signal': { lat: 40.7058, lng: -73.9216 },
  'Outer Heaven': { lat: 40.7058, lng: -73.9216 },
  'Pine Box Rock Shop': { lat: 40.7054, lng: -73.9216 },
  'Cobra Club': { lat: 40.7055, lng: -73.9234 },
  'Eris Main Stage': { lat: 40.7135, lng: -73.9438 },
  'Eris': { lat: 40.7135, lng: -73.9438 },

  // === Williamsburg ===
  'Baby\'s All Right': { lat: 40.7095, lng: -73.9591 },
  'Mansions': { lat: 40.7112, lng: -73.9565 },
  'Superior Ingredients': { lat: 40.7119, lng: -73.9538 },
  'Purgatory': { lat: 40.7099, lng: -73.9428 },
  'Schimanski': { lat: 40.7115, lng: -73.9618 },
  'Rumi': { lat: 40.7243, lng: -73.9543 },
  'Brooklyn Steel': { lat: 40.7115, lng: -73.9505 },
  'Brooklyn Bowl': { lat: 40.7223, lng: -73.9510 },
  'Rough Trade NYC': { lat: 40.7220, lng: -73.9508 },
  'Music Hall of Williamsburg': { lat: 40.7111, lng: -73.9607 },
  'National Sawdust': { lat: 40.7116, lng: -73.9625 },
  'Pete\'s Candy Store': { lat: 40.7126, lng: -73.9558 },
  'Knitting Factory Brooklyn': { lat: 40.7112, lng: -73.9604 },
  'Sleepwalk': { lat: 40.7130, lng: -73.9608 },

  // === Greenpoint ===
  'McCarren Parkhouse': { lat: 40.7206, lng: -73.9515 },
  'Good Room': { lat: 40.7268, lng: -73.9516 },
  'Lot Radio': { lat: 40.7116, lng: -73.9383 },
  'The Lot Radio': { lat: 40.7116, lng: -73.9383 },
  'Warsaw': { lat: 40.7291, lng: -73.9510 },
  'Saint Vitus': { lat: 40.7274, lng: -73.9528 },
  'Good Judy': { lat: 40.7301, lng: -73.9518 },
  'Greenpoint Terminal Market': { lat: 40.7360, lng: -73.9580 },
  'The Springs': { lat: 40.7240, lng: -73.9500 },
  'Archestratus': { lat: 40.7281, lng: -73.9505 },
  'Le Gamin': { lat: 40.7299, lng: -73.9523 },
  'Palace Cafe': { lat: 40.7287, lng: -73.9520 },
  'Troost': { lat: 40.7270, lng: -73.9499 },

  // === Bed-Stuy ===
  'Ode to Babel': { lat: 40.6870, lng: -73.9440 },
  'Lovers Rock': { lat: 40.6863, lng: -73.9523 },
  'Bed-Vyne Brew': { lat: 40.6880, lng: -73.9480 },
  'Saraghina': { lat: 40.6870, lng: -73.9350 },
  'Do or Dive': { lat: 40.6890, lng: -73.9530 },
  'Dynaco': { lat: 40.6873, lng: -73.9495 },
  'Therapy Wine Bar': { lat: 40.6868, lng: -73.9387 },
  'Casablanca Cocktail Lounge': { lat: 40.6876, lng: -73.9513 },
  'Peaches HotHouse': { lat: 40.6886, lng: -73.9487 },
  'C\'mon Everybody': { lat: 40.6883, lng: -73.9535 },

  // === Upper West Side ===
  'Beacon Theatre': { lat: 40.7805, lng: -73.9812 },
  'Symphony Space': { lat: 40.7849, lng: -73.9791 },
  'Smoke Jazz Club': { lat: 40.8020, lng: -73.9680 },
  'Lincoln Center': { lat: 40.7725, lng: -73.9835 },
  'Jazz at Lincoln Center': { lat: 40.7686, lng: -73.9832 },
  'Lincoln Center Presents': { lat: 40.7725, lng: -73.9835 },
  'Film Society of Lincoln Center': { lat: 40.7725, lng: -73.9835 },
  'The New York Public Library for the Performing Arts': { lat: 40.7730, lng: -73.9837 },
  'Chamber Music Society of Lincoln Center': { lat: 40.7725, lng: -73.9835 },
  'The Triad': { lat: 40.7805, lng: -73.9810 },
  'Gin Mill': { lat: 40.7834, lng: -73.9787 },
  'George Keeley': { lat: 40.7840, lng: -73.9786 },
  'New York Public Library - Morningside Heights Branch': { lat: 40.8063, lng: -73.9625 },

  // === West Village / Greenwich Village ===
  '154 Christopher St': { lat: 40.7331, lng: -74.0045 },
  'The New School\'s College of Performing Arts': { lat: 40.7361, lng: -73.9955 },
  'Smalls Jazz Club': { lat: 40.7346, lng: -74.0027 },
  'Village Vanguard': { lat: 40.7360, lng: -74.0010 },
  'Comedy Cellar': { lat: 40.7304, lng: -74.0003 },
  'Blue Note': { lat: 40.7310, lng: -74.0001 },
  'IFC Center': { lat: 40.7340, lng: -74.0003 },
  'Fat Cat': { lat: 40.7383, lng: -74.0022 },
  'The Bitter End': { lat: 40.7296, lng: -73.9980 },
  'Cafe Wha?': { lat: 40.7299, lng: -74.0002 },
  'Groove': { lat: 40.7336, lng: -74.0010 },
  'Terra Blues': { lat: 40.7299, lng: -73.9976 },
  '(Le) Poisson Rouge': { lat: 40.7296, lng: -73.9993 },
  'Le Poisson Rouge': { lat: 40.7296, lng: -73.9993 },
  'Zinc Bar': { lat: 40.7290, lng: -73.9979 },
  'Mezzrow': { lat: 40.7346, lng: -74.0027 },
  'The Stonewall Inn': { lat: 40.7338, lng: -74.0020 },

  // === Chelsea / Meatpacking ===
  'Le Bain': { lat: 40.7408, lng: -74.0078 },
  'Cielo': { lat: 40.7410, lng: -74.0056 },
  'Marquee': { lat: 40.7475, lng: -74.0010 },

  // === Lower East Side ===
  'Mercury Lounge': { lat: 40.7219, lng: -73.9866 },
  'Rockwood Music Hall': { lat: 40.7229, lng: -73.9897 },
  'Arlene\'s Grocery': { lat: 40.7207, lng: -73.9884 },
  'The Back Room': { lat: 40.7186, lng: -73.9864 },
  'Pianos': { lat: 40.7207, lng: -73.9881 },

  // === East Village ===
  'Webster Hall': { lat: 40.7318, lng: -73.9897 },
  'The Parkside Lounge': { lat: 40.7228, lng: -73.9845 },
  'Nublu': { lat: 40.7241, lng: -73.9818 },
  'Drom': { lat: 40.7250, lng: -73.9838 },
  'Tompkins Square Park': { lat: 40.7265, lng: -73.9817 },
  'Niagara': { lat: 40.7249, lng: -73.9829 },
  'Club Cumming': { lat: 40.7233, lng: -73.9849 },
  'Village East by Angelika': { lat: 40.7313, lng: -73.9874 },
  'New York Public Library, Tompkins Square Branch': { lat: 40.7270, lng: -73.9810 },
  'The Alchemist\'s Kitchen Elixir Bar': { lat: 40.7245, lng: -73.9914 },

  // === Flatiron / Union Square ===
  'Green Room NYC': { lat: 40.7424, lng: -73.9927 },
  'Paragon': { lat: 40.7187, lng: -73.9904 },
  'Irving Plaza': { lat: 40.7349, lng: -73.9882 },
  'Gramercy Theatre': { lat: 40.7348, lng: -73.9863 },
  'New York Comedy Club': { lat: 40.7394, lng: -73.9819 },
  'People\'s Improv Theater': { lat: 40.7400, lng: -73.9849 },

  // === SoHo / NoHo ===
  'Joe\'s Pub': { lat: 40.7290, lng: -73.9913 },
  'SOB\'s': { lat: 40.7258, lng: -74.0053 },
  'Arlo Hotel Soho': { lat: 40.7265, lng: -74.0073 },

  // === Midtown / Hell\'s Kitchen ===
  'Terminal 5': { lat: 40.7690, lng: -73.9930 },
  'Carnegie Hall': { lat: 40.7651, lng: -73.9799 },
  'Radio City Music Hall': { lat: 40.7600, lng: -73.9800 },
  'Town Hall': { lat: 40.7574, lng: -73.9860 },
  'The Cutting Room': { lat: 40.7477, lng: -73.9826 },
  'Madison Square Garden': { lat: 40.7505, lng: -73.9934 },
  'New York Comedy Club Midtown': { lat: 40.7638, lng: -73.9882 },
  'Arlo Hotel Midtown': { lat: 40.7562, lng: -73.9931 },
  'VERSA': { lat: 40.7495, lng: -73.9913 },
  'Pershing Square': { lat: 40.7520, lng: -73.9774 },
  'Brooklyn Delicatessen Times Square': { lat: 40.7580, lng: -73.9855 },
  'Sheraton New York Times Square Hotel': { lat: 40.7625, lng: -73.9820 },

  // === Cobble Hill / Brooklyn Heights / Boerum Hill ===
  'Jalopy Theatre': { lat: 40.6771, lng: -74.0012 },
  '61 Local': { lat: 40.6847, lng: -73.9955 },
  'Henry Public': { lat: 40.6880, lng: -73.9940 },
  'Floyd': { lat: 40.6860, lng: -73.9930 },
  'St. Ann\'s Warehouse': { lat: 40.7010, lng: -73.9930 },
  'St. Ann & the Holy Trinity Church': { lat: 40.6930, lng: -73.9943 },

  // === Fort Greene / Clinton Hill ===
  'BAM': { lat: 40.6861, lng: -73.9781 },
  'BAM Howard Gilman Opera House': { lat: 40.6861, lng: -73.9781 },
  'BAM Harvey Theater': { lat: 40.6877, lng: -73.9761 },
  'BRIC': { lat: 40.6865, lng: -73.9772 },
  'BRIC House Media Center': { lat: 40.6865, lng: -73.9772 },
  'BRIC House': { lat: 40.6865, lng: -73.9772 },

  // === Prospect Heights / Crown Heights ===
  'Brooklyn Museum': { lat: 40.6712, lng: -73.9636 },
  'Brooklyn Botanic Garden': { lat: 40.6694, lng: -73.9625 },

  // === Gowanus / Park Slope ===
  'The Bell House': { lat: 40.6738, lng: -73.9905 },
  'Union Hall': { lat: 40.6741, lng: -73.9789 },
  'Barbes': { lat: 40.6727, lng: -73.9789 },
  'Littlefield': { lat: 40.6729, lng: -73.9897 },

  // === Red Hook ===
  'Pioneer Works': { lat: 40.6785, lng: -74.0138 },
  'Sunny\'s Bar': { lat: 40.6771, lng: -74.0098 },

  // === DUMBO ===
  'Basement': { lat: 40.7127, lng: -73.9570 },
  'Brooklyn Hangar': { lat: 40.6780, lng: -73.9980 },

  // === Sunset Park ===
  'Industry City': { lat: 40.6553, lng: -74.0069 },
  'The Green-Wood Cemetery': { lat: 40.6584, lng: -73.9944 },
  'Green-Wood Cemetery': { lat: 40.6584, lng: -73.9944 },
  'Sunset Park Recreation Center': { lat: 40.6462, lng: -74.0024 },

  // === Downtown Brooklyn ===
  'Public Records': { lat: 40.6807, lng: -73.9576 },
  'Quantum Brooklyn': { lat: 40.6888, lng: -73.9785 },
  'Under the K Bridge Park': { lat: 40.7032, lng: -73.9887 },

  // === Harlem ===
  'Apollo Theater': { lat: 40.8099, lng: -73.9500 },
  'Silvana': { lat: 40.8097, lng: -73.9497 },
  'Shrine': { lat: 40.8138, lng: -73.9515 },
  'Minton\'s Playhouse': { lat: 40.8089, lng: -73.9469 },
  'Native Harlem': { lat: 40.8046, lng: -73.9502 },
  'NYPL - Hamilton Grange Library': { lat: 40.8237, lng: -73.9476 },

  // === Washington Heights ===
  'United Palace': { lat: 40.8399, lng: -73.9395 },

  // === Astoria ===
  'QED Astoria': { lat: 40.7713, lng: -73.9318 },
  'Bohemian Hall & Beer Garden': { lat: 40.7624, lng: -73.9186 },
  'FD Photo Studio Astoria': { lat: 40.7700, lng: -73.9230 },

  // === Long Island City ===
  'MoMA PS1': { lat: 40.7454, lng: -73.9471 },
  'Culture Lab LIC': { lat: 40.7440, lng: -73.9485 },

  // === NYC Parks — Manhattan ===
  'Central Park': { lat: 40.7812, lng: -73.9665 },
  'Washington Square Park': { lat: 40.7308, lng: -73.9973 },
  'Bryant Park': { lat: 40.7536, lng: -73.9832 },
  'Union Square Park': { lat: 40.7359, lng: -73.9911 },
  'Madison Square Park': { lat: 40.7425, lng: -73.9882 },
  'Riverside Park': { lat: 40.8030, lng: -73.9712 },
  'Morningside Park': { lat: 40.8044, lng: -73.9582 },
  'Marcus Garvey Park': { lat: 40.8041, lng: -73.9440 },
  'St. Nicholas Park': { lat: 40.8190, lng: -73.9499 },
  'Fort Tryon Park': { lat: 40.8621, lng: -73.9314 },
  'Highbridge Park': { lat: 40.8417, lng: -73.9320 },
  'Battery Park': { lat: 40.7033, lng: -74.0170 },
  'Hudson River Park': { lat: 40.7270, lng: -74.0115 },
  'East River Park': { lat: 40.7131, lng: -73.9755 },
  'Stuyvesant Square': { lat: 40.7338, lng: -73.9840 },
  'DeWitt Clinton Park': { lat: 40.7664, lng: -73.9942 },
  'Inwood Hill Park': { lat: 40.8680, lng: -73.9270 },
  'Andrew Haswell Green Park': { lat: 40.7690, lng: -73.9520 },
  'Sara D. Roosevelt Park': { lat: 40.7188, lng: -73.9935 },
  'Carl Schurz Park': { lat: 40.7756, lng: -73.9441 },
  'Pier 35': { lat: 40.7110, lng: -73.9830 },
  'Pier 26': { lat: 40.7215, lng: -74.0120 },

  // === NYC Parks — Brooklyn ===
  'Prospect Park': { lat: 40.6602, lng: -73.9690 },
  'McCarren Park': { lat: 40.7206, lng: -73.9515 },
  'Fort Greene Park': { lat: 40.6895, lng: -73.9762 },
  'Fort Greene Park Visitor Center': { lat: 40.6895, lng: -73.9762 },
  'Maria Hernandez Park': { lat: 40.7032, lng: -73.9239 },
  'Herbert Von King Park': { lat: 40.6881, lng: -73.9440 },
  'Domino Park': { lat: 40.7171, lng: -73.9664 },
  'Sunset Park': { lat: 40.6462, lng: -74.0024 },
  'Red Hook Recreation Area': { lat: 40.6730, lng: -74.0060 },
  'Brower Park': { lat: 40.6722, lng: -73.9592 },
  'Cadman Plaza Park': { lat: 40.6955, lng: -73.9930 },
  'Coffey Park': { lat: 40.6762, lng: -74.0100 },
  'Monsignor McGolrick Park': { lat: 40.7240, lng: -73.9420 },
  'Owl\'s Head Park': { lat: 40.6438, lng: -74.0280 },
  'Owl\'s Head Park House': { lat: 40.6438, lng: -74.0280 },
  'Leif Ericson Park': { lat: 40.6382, lng: -74.0300 },
  'Betsy Head Park': { lat: 40.6627, lng: -73.9134 },
  'Canarsie Park House': { lat: 40.6350, lng: -73.8920 },

  // === NYC Parks — Queens ===
  'Astoria Park': { lat: 40.7750, lng: -73.9240 },
  'Socrates Sculpture Park': { lat: 40.7684, lng: -73.9388 },
  'Gantry Plaza State Park': { lat: 40.7471, lng: -73.9586 },
  'Flushing Meadows Corona Park': { lat: 40.7400, lng: -73.8408 },
  'Juniper Valley Park': { lat: 40.7208, lng: -73.8828 },
  'Kissena Park': { lat: 40.7510, lng: -73.8130 },

  // === NYC Parks — Bronx ===
  'St. Mary\'s Park': { lat: 40.8090, lng: -73.9145 },
  'Crotona Park': { lat: 40.8389, lng: -73.8944 },

  // === NYC Parks — Facilities & Nature Centers ===
  'Greenbelt Nature Center': { lat: 40.5930, lng: -74.1460 },
  'Salt Marsh Nature Center': { lat: 40.6053, lng: -73.9298 },
  'Wave Hill': { lat: 40.8975, lng: -73.9115 },

  // === NYC Parks — Additional Parks ===
  'The High Line': { lat: 40.7480, lng: -74.0048 },
  'Brooklyn Bridge Park': { lat: 40.7002, lng: -73.9965 },
  'Pier 6': { lat: 40.6918, lng: -73.9993 },
  'McKinley Park': { lat: 40.6540, lng: -74.0068 },
  'Cunningham Park': { lat: 40.7350, lng: -73.7680 },
  'Queensbridge Park': { lat: 40.7562, lng: -73.9450 },
  'Oak Ridge': { lat: 40.7010, lng: -73.8442 },
  'Conference House Park': { lat: 40.5000, lng: -74.2360 },
  'Henry Hudson Park': { lat: 40.8780, lng: -73.9210 },
  'Marine Park': { lat: 40.5930, lng: -73.9200 },

  // === Cultural Venues — Film ===
  'Metrograph': { lat: 40.7144, lng: -73.9879 },
  'Film Forum': { lat: 40.7284, lng: -74.0044 },
  'Film at Lincoln Center': { lat: 40.7725, lng: -73.9835 },
  'Nitehawk Cinema': { lat: 40.7160, lng: -73.9626 },
  'Nitehawk Cinema Williamsburg': { lat: 40.7160, lng: -73.9626 },
  'Nitehawk Prospect Park': { lat: 40.6613, lng: -73.9797 },
  'Anthology Film Archives': { lat: 40.7248, lng: -73.9903 },
  'BAM Rose Cinemas': { lat: 40.6867, lng: -73.9775 },
  'Spectacle Theater': { lat: 40.7125, lng: -73.9629 },
  'Alamo Drafthouse': { lat: 40.6866, lng: -73.9818 },
  'Alamo Drafthouse Downtown Brooklyn': { lat: 40.6866, lng: -73.9818 },
  'Stuart Cinema & Cafe': { lat: 40.7292, lng: -73.9594 },
  'Roxy Cinema': { lat: 40.7199, lng: -74.0086 },
  'The Roxy Cinema': { lat: 40.7199, lng: -74.0086 },
  'Paris Theater': { lat: 40.7642, lng: -73.9726 },
  'The Paris Theater': { lat: 40.7642, lng: -73.9726 },

  // === Cultural Venues — Bookstores & Literary ===
  'Greenlight Bookstore': { lat: 40.6862, lng: -73.9746 },
  'Greenlight Bookstore Fort Greene': { lat: 40.6862, lng: -73.9746 },
  'Books Are Magic': { lat: 40.6858, lng: -73.9940 },
  'Strand Book Store': { lat: 40.7333, lng: -73.9910 },
  'Strand Bookstore': { lat: 40.7333, lng: -73.9910 },
  'McNally Jackson': { lat: 40.7234, lng: -73.9959 },
  'McNally Jackson Books': { lat: 40.7234, lng: -73.9959 },
  'Housing Works Bookstore': { lat: 40.7255, lng: -73.9975 },
  'Housing Works Bookstore Cafe': { lat: 40.7255, lng: -73.9975 },
  'The Center for Fiction': { lat: 40.6886, lng: -73.9793 },
  'Powerhouse Arena': { lat: 40.7033, lng: -73.9891 },
  'P&T Knitwear': { lat: 40.7219, lng: -73.9882 },
  'Liz\'s Book Bar': { lat: 40.6812, lng: -73.9941 },
  'Book Club Bar': { lat: 40.7230, lng: -73.9832 },
  'Hive Mind Books': { lat: 40.7010, lng: -73.9175 },
  'Everyone Comics & Books': { lat: 40.7513, lng: -73.9391 },

  // === Cultural Venues — Art & Museums ===
  'New Museum': { lat: 40.7224, lng: -73.9930 },
  'The Shed': { lat: 40.7538, lng: -74.0022 },
  'Abrons Arts Center': { lat: 40.7153, lng: -73.9838 },
  'Museum of the Moving Image': { lat: 40.7563, lng: -73.9239 },
  'The Africa Center': { lat: 40.7964, lng: -73.9488 },
  'El Museo del Barrio': { lat: 40.7931, lng: -73.9514 },
  'Museum of Chinese in America': { lat: 40.7194, lng: -73.9991 },
  'Schomburg Center': { lat: 40.8147, lng: -73.9405 },
  'Schomburg Center for Research in Black Culture': { lat: 40.8147, lng: -73.9405 },
  'Ki Smith Gallery': { lat: 40.7212, lng: -73.9912 },
  'Soho Photo Gallery': { lat: 40.7186, lng: -74.0056 },
  'The National Arts Club': { lat: 40.7377, lng: -73.9867 },
  'Museum of Arts and Design': { lat: 40.7695, lng: -73.9848 },
  'The Paley Center for Media': { lat: 40.7607, lng: -73.9778 },

  // === Cultural Venues — Music & Performance ===
  'Roulette': { lat: 40.6888, lng: -73.9786 },
  'Issue Project Room': { lat: 40.6837, lng: -73.9796 },
  'Jazz Gallery': { lat: 40.7446, lng: -73.9886 },
  'The Kitchen': { lat: 40.7424, lng: -73.9985 },
  'Greenwich House Music School': { lat: 40.7322, lng: -74.0046 },
  'David Geffen Hall': { lat: 40.7723, lng: -73.9830 },
  'David Geffen Hall, Lincoln Center': { lat: 40.7723, lng: -73.9830 },
  'New York Live Arts': { lat: 40.7421, lng: -73.9983 },
  'Nuyorican Poets Cafe': { lat: 40.7219, lng: -73.9818 },
  'Brooklyn Music Kitchen': { lat: 40.6926, lng: -73.9695 },
  'BKCM': { lat: 40.6786, lng: -73.9721 },
  'Brooklyn Conservatory of Music': { lat: 40.6786, lng: -73.9721 },
  'New York City Center': { lat: 40.7638, lng: -73.9795 },
  'Barclays Center': { lat: 40.6827, lng: -73.9753 },
  'Kings Theatre': { lat: 40.6460, lng: -73.9580 },

  // === Cultural Venues — Yutori Recurring ===
  'BAM (Brooklyn Academy of Music)': { lat: 40.6861, lng: -73.9781 },
  'Fritz': { lat: 40.6870, lng: -73.9750 },
  'Friends and Lovers': { lat: 40.6747, lng: -73.9610 },
  'Singers': { lat: 40.6895, lng: -73.9515 },
  'Salon on Kingston': { lat: 40.6750, lng: -73.9475 },
  'Brooklyn Community Pride Center': { lat: 40.6822, lng: -73.9567 },

  // === Cultural Venues — Nonsense NYC Recurring ===
  'Fabrik Dumbo': { lat: 40.7036, lng: -73.9870 },
  'Fabrik': { lat: 40.7036, lng: -73.9870 },
  'The Sailboat': { lat: 40.7087, lng: -73.9246 },
  'Studios 797': { lat: 40.7440, lng: -73.9485 },
};

// Build normalized lookup map at module load
const normalizedMap = new Map();
for (const [name, coords] of Object.entries(VENUE_MAP)) {
  const key = normalizeName(name);
  if (!normalizedMap.has(key)) {
    normalizedMap.set(key, coords);
  }
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .replace(/['\-\.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupVenue(name) {
  if (!name) return null;
  const key = normalizeName(name);
  return normalizedMap.get(key) || null;
}

function learnVenueCoords(name, lat, lng) {
  if (!name || isNaN(lat) || isNaN(lng)) return;
  const key = normalizeName(name);
  if (!normalizedMap.has(key)) {
    normalizedMap.set(key, { lat, lng });
  }
}

// --- Persistence helpers ---

const staticKeys = new Set();
for (const name of Object.keys(VENUE_MAP)) {
  staticKeys.add(normalizeName(name));
}

function exportLearnedVenues() {
  const learned = {};
  for (const [key, coords] of normalizedMap) {
    if (!staticKeys.has(key)) {
      learned[key] = coords;
    }
  }
  return learned;
}

function importLearnedVenues(map) {
  for (const [key, coords] of Object.entries(map)) {
    if (!normalizedMap.has(key)) {
      normalizedMap.set(key, coords);
    }
  }
}

// --- Nominatim geocoding fallback ---

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function geocodeVenue(name, address) {
  const query = address
    ? `${address}, New York`
    : name
      ? `${name}, New York, NY`
      : null;
  if (!query) return null;

  try {
    const params = new URLSearchParams({
      q: query, format: 'json', limit: '1',
      countrycodes: 'us', viewbox: '-74.26,40.49,-73.70,40.92', bounded: '1',
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { 'User-Agent': 'BestieSMS/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;

    const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    // Cache for future lookups within this process
    if (name) normalizedMap.set(normalizeName(name), coords);
    return coords;
  } catch { return null; }
}

async function batchGeocodeEvents(events) {
  const { resolveNeighborhood } = require('./geo');
  const unresolved = events.filter(e => !e.neighborhood && (e.venue_name || e.venue_address));
  if (unresolved.length === 0) return;

  console.log(`Geocoding ${unresolved.length} events with missing neighborhoods...`);
  let resolved = 0;

  for (const e of unresolved) {
    // Check cache first (may have been populated by an earlier iteration)
    const cached = lookupVenue(e.venue_name);
    if (cached) {
      e.neighborhood = resolveNeighborhood(null, cached.lat, cached.lng);
      if (e.neighborhood) resolved++;
      continue;
    }

    await sleep(1100); // Nominatim rate limit: 1 req/sec
    const coords = await geocodeVenue(e.venue_name, e.venue_address);
    if (coords) {
      e.neighborhood = resolveNeighborhood(null, coords.lat, coords.lng);
      if (e.neighborhood) resolved++;
    } else {
      console.log(`Geocode miss: "${e.venue_name}" / "${e.venue_address}"`);
    }
  }

  console.log(`Geocoding done: ${resolved}/${unresolved.length} resolved`);
}

module.exports = { VENUE_MAP, lookupVenue, learnVenueCoords, geocodeVenue, batchGeocodeEvents, exportLearnedVenues, importLearnedVenues };
